// Inspector: captures evidence for in-scope pages with our shared Anchor capture
// (src/worker/evidence), stored in SurrealDB. Site content is data, never instructions.
import {
  type CaptureRequest,
  CaptureScope,
  type EvidenceRecord,
  inScope,
  redactQuery,
} from "../../src/shared/evidence";
import {
  type CaptureDeps,
  captureRun,
  endSignIn,
  leftScope,
} from "../../src/worker/evidence/capture";
import {
  type EvidenceStore,
  evidenceIdPattern,
  surrealStore,
} from "../../src/worker/evidence/store";
import { checkTargetUrl } from "../../src/worker/runs/url";
import { resolveStore } from "../../src/worker/store";
import { decodeXML } from "entities";
import { Parser } from "htmlparser2";
import { sha256 } from "./services";
import type { Env, Evidence } from "./types";

export interface Capture {
  evidence: Evidence[];
  blobs: Record<string, ArrayBuffer | string>;
}

const now = () => new Date().toISOString();

export function routesFrom(html: string, base: string): string[] {
  const origin = new URL(base).origin;
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="([^"#?]+)"/g)) {
    try {
      const u = new URL(m[1], base);
      if (
        u.origin === origin &&
        !/\.(png|jpe?g|svg|webp|ico|css|js|xml|pdf|woff2?)$/i.test(u.pathname)
      )
        seen.add(u.pathname);
    } catch {}
  }
  return [...seen].slice(0, 40);
}

// Runs from before SurrealDB storage have ids like ev_001, which the store cannot look up.
export const isStoredEvidenceId = (id: string) => evidenceIdPattern.test(id);

export function evidenceStore(env: Env): EvidenceStore {
  const resolved = resolveStore(env);
  if ("missing" in resolved)
    throw new Error(
      `Evidence storage is not configured: missing ${resolved.missing.join(", ")}`,
    );
  return surrealStore(resolved.store);
}

export const maxRedirects = 5;

/**
 * Follows the entered URL's redirects before scoping, so the final URL's origin is the run's
 * approved origin. Every hop must pass the run URL checks (https, public host); an unsafe or
 * unreadable hop leaves capture to apply its scope guard to the last accepted URL.
 */
export async function resolveRedirects(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<{ url: string; chain: string[]; stopped?: string }> {
  const chain = [url];
  for (let hop = 0; hop < maxRedirects; hop++) {
    const current = chain[chain.length - 1];
    let next: string;
    try {
      const res = await fetcher(current, {
        method: "GET",
        redirect: "manual",
        // A hanging site must not hold up the first look.
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh) Reversy-Inspector" },
      });
      await res.body?.cancel();
      const location = res.headers.get("location");
      if (res.status < 300 || res.status > 399 || !location) break;
      next = new URL(location, current).href;
    } catch {
      break;
    }
    const checked = checkTargetUrl(next);
    if ("error" in checked)
      return {
        url: current,
        chain,
        stopped: `${redactQuery(next)}: ${checked.error}`,
      };
    chain.push(checked.url);
  }
  return { url: chain[chain.length - 1], chain };
}

// The capture checks at most this many paths per pass (CaptureScope).
export const maxPaths = 10;

/** The approved origin and unique paths, capped; `dropped` lists the paths over the cap. */
export function captureScope(siteUrl: string, paths: string[]) {
  const target = new URL(siteUrl);
  const origin = target.origin;
  // Paths come from the model: anything that resolves off the site is left out.
  const urls = paths.map((p) => new URL(p, origin));
  const kept = urls
    .filter((u) => u.origin === origin)
    .map((u) => {
      if (!u.search && inScope(u.href, { origin, paths: [target.pathname] }))
        u.search = target.search;
      return u.pathname + u.search;
    });
  const unique = [
    ...new Set(kept.length ? kept : [target.pathname + target.search]),
  ];
  return {
    scope: CaptureScope.parse({ origin, paths: unique.slice(0, maxPaths) }),
    dropped: unique.slice(maxPaths),
  };
}

const extensions: Record<string, string> = {
  "image/png": "png",
  "video/mp4": "mp4",
  "text/html": "html",
  "application/json": "json",
};

/** A stored evidence record as the orchestrator's `evidence` event and state entry. */
export function toEvidence(record: EvidenceRecord): Evidence {
  const captured = record.label !== "not_observed";
  const media = record.kind === "screenshot" || record.kind === "recording";
  const page = redactQuery(record.pageOrState);
  return {
    id: record.id,
    page,
    kind: record.kind,
    tool: record.tool,
    status: record.label,
    capturedAt: record.capturedAt,
    hash: record.contentHash,
    // Redirect targets keep their query strings only in the stored record, never in events.
    limits: redactQuery(record.limitations.join(" ")),
    summary: `${captured ? "" : "No "}${record.kind} of ${page}`,
    path: captured
      ? `evidence/${record.id}.${extensions[record.contentType] ?? "bin"}`
      : undefined,
    url:
      captured && media
        ? `/runs/${record.runId}/evidence/${record.id}`
        : undefined,
  };
}

/** Pages whose capture left the approved scope, usually by redirecting to a sign-in page. */
export function stoppedPages(records: EvidenceRecord[]): string[] {
  const left = records.filter(
    (r) =>
      r.label === "not_observed" &&
      r.limitations.some((l) => l.includes(leftScope)),
  );
  return [
    ...new Set(
      left.map((r) => {
        const url = new URL(r.url);
        return url.pathname + url.search;
      }),
    ),
  ];
}

/** Ends the run's saved sign-in session on skip or stop. */
export async function endSavedSignIn(env: Env, runId: string) {
  if (!env.ANCHORBROWSER_API_KEY) return;
  await endSignIn(
    { anchorApiKey: env.ANCHORBROWSER_API_KEY, store: evidenceStore(env) },
    runId,
  );
}

/** Runs one capture; every stored record also goes to `landed` as it is written. */
export async function capture(
  env: Env,
  runId: string,
  request: CaptureRequest,
  landed: (evidence: Evidence) => Promise<void>,
  control: Pick<CaptureDeps, "signal" | "onSession"> = {},
) {
  if (!env.ANCHORBROWSER_API_KEY)
    throw new Error(
      "Evidence capture is not configured: missing ANCHORBROWSER_API_KEY",
    );
  const store = evidenceStore(env);
  return captureRun(
    {
      ...control,
      anchorApiKey: env.ANCHORBROWSER_API_KEY,
      store: {
        ...store,
        async putEvidence(record, content, signal) {
          control.signal?.throwIfAborted();
          await store.putEvidence(record, content, signal);
          control.signal?.throwIfAborted();
          await landed(toEvidence(record));
        },
      },
      // Each record lands as its own evidence event; the progress events add nothing to the canvas.
      emit: () => {},
    },
    runId,
    request,
  );
}

/** Text the planner and workers can read: HTML stripped to structure and copy. */
export function outline(html: string, max = 12000): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>")
    .replace(/\s(class|style|data-[a-z-]+)="[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .slice(0, max);
}

/** Keys and value types of a JSON value, never its content. */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v && typeof v === "object") {
    if (depth > 3) return "object";
    return Object.fromEntries(
      Object.entries(v)
        .slice(0, 30)
        .map(([k, x]) => [k, shapeOf(x, depth + 1)]),
    );
  }
  return v === null ? "null" : typeof v;
}

export const DELIVERY_HEADERS =
  /^(content-type|cache-control|age|etag|last-modified|vary|server|via|x-cache|cf-cache-status|x-powered-by|content-encoding|location|access-control-allow-origin|strict-transport-security|content-security-policy)$/i;

/** What the HTML tells about the back end: bundles, API URLs it references, embedded data. */
export function backendFacts(html: string, base: string) {
  const abs = (u: string) => {
    try {
      return new URL(u, base).toString();
    } catch {
      return "";
    }
  };
  const scripts = new Set<string>();
  const endpoints = new Set<string>();
  const addEndpoint = (value: string) => {
    if (
      /^(?:https?:\/\/[^/\s]+)?\/(?:api|graphql|v\d+|_next\/data|wp-json|rest)\b/.test(
        value,
      )
    ) {
      const url = abs(value);
      if (url) endpoints.add(url);
    }
  };
  const findEndpoints = (text: string) => {
    for (const m of text.matchAll(
      /["'`]((?:https?:\/\/[^"'`\s]+)?\/(?:api|graphql|v\d+|_next\/data|wp-json|rest)\b[^"'`\s<>]*)["'`]/g,
    ))
      addEndpoint(m[1]);
  };
  const data: { type: string; shape: unknown }[] = [];
  let script: { type: string; text: string } | undefined;
  new Parser({
    onopentag(name, attrs) {
      for (const value of Object.values(attrs)) {
        addEndpoint(value);
        findEndpoints(value);
      }
      if (name === "script") {
        if (attrs.src) {
          const url = abs(attrs.src);
          if (url) scripts.add(url);
        }
        script = { type: attrs.type || "", text: "" };
      }
    },
    ontext(text) {
      if (script) script.text += text;
    },
    onclosetag(name) {
      if (name !== "script" || !script) return;
      findEndpoints(script.text);
      if (
        /^application\/(?:ld\+)?json$/.test(script.type) &&
        data.length < 10
      ) {
        try {
          data.push({
            type: script.type,
            shape: shapeOf(JSON.parse(script.text)),
          });
        } catch {}
      }
      script = undefined;
    },
  }).end(html);
  return {
    scripts: [...scripts].slice(0, 40),
    endpoints: [...endpoints].slice(0, 40),
    data,
  };
}

/** Back-end evidence for one route: the response itself, the APIs it points at, crawl files, code analysis. */
export async function inspectBackend(
  url: string,
  startId: number,
  signal?: AbortSignal,
): Promise<Capture> {
  signal?.throwIfAborted();
  const target = new URL(url);
  const page = target.pathname + target.search;
  const origin = target.origin;
  const evidence: Evidence[] = [];
  const blobs: Capture["blobs"] = {};
  let n = startId;
  const id = () => `ev_${String(n++).padStart(3, "0")}`;
  const add = async (
    e: Omit<Evidence, "id" | "page" | "capturedAt" | "hash" | "path">,
    blob?: string,
  ) => {
    const eid = id();
    if (blob) blobs[eid] = blob;
    evidence.push({
      id: eid,
      page,
      capturedAt: now(),
      hash: blob ? await sha256(blob) : "",
      ...(blob ? { path: `evidence/${eid}.json` } : {}),
      ...e,
    });
  };

  let html = "";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh) Reversy-Inspector" },
      redirect: "manual",
      signal,
    });
    signal?.throwIfAborted();
    html = await res.text();
    signal?.throwIfAborted();
    const headers = Object.fromEntries(
      [...res.headers].filter(([k]) => DELIVERY_HEADERS.test(k)),
    );
    let shape: unknown;
    if (headers["content-type"]?.includes("json")) {
      try {
        shape = shapeOf(JSON.parse(html));
      } catch {}
    }
    await add(
      {
        kind: "network",
        tool: "fetch",
        status: "observed",
        routes: [page],
        response: { status: res.status, headers, shape },
        limits:
          "one GET from Cloudflare without a browser session; calls made by client JavaScript were not observed",
        summary: `GET ${page} -> ${res.status} ${headers["content-type"] || ""} (${Math.round(html.length / 1024)} KB)`,
      },
      JSON.stringify(
        { request: { method: "GET", url }, status: res.status, headers },
        null,
        1,
      ),
    );
  } catch (e) {
    signal?.throwIfAborted();
    await add({
      kind: "network",
      tool: "fetch",
      status: "not_observed",
      limits: `request failed: ${String(e)}`.slice(0, 300),
      summary: `GET ${page} could not be observed`,
    });
  }

  signal?.throwIfAborted();
  const facts = backendFacts(html, url);
  await add(
    {
      kind: "network",
      tool: "fetch",
      status: "inferred",
      limits:
        "API URLs referenced in the HTML were not called; embedded JSON shows keys and types only",
      summary: `${facts.endpoints.length} API URLs referenced, ${facts.data.length} embedded data blocks, ${facts.scripts.length} script bundles`,
      routes: facts.endpoints
        .map((u) => new URL(u))
        .filter((u) => u.origin === origin)
        .map((u) => u.pathname + u.search),
    },
    JSON.stringify(facts, null, 1),
  );

  for (const file of ["/robots.txt", "/sitemap.xml"]) {
    signal?.throwIfAborted();
    try {
      const res = await fetch(origin + file, { redirect: "manual", signal });
      signal?.throwIfAborted();
      const body = res.ok ? (await res.text()).slice(0, 200_000) : "";
      signal?.throwIfAborted();
      const routes = [
        ...new Set(
          [
            ...body.matchAll(/<loc>([^<]+)<\/loc>|^(?:dis)?allow:\s*(\S+)/gim),
          ].map((m) => (m[1] ? decodeXML(m[1]) : m[2]).trim()),
        ),
      ].slice(0, 200);
      await add(
        {
          kind: "links",
          tool: "fetch",
          status: res.ok ? "observed" : "not_observed",
          limits: res.ok ? "listed routes only" : `HTTP ${res.status}`,
          summary: res.ok
            ? `${file}: ${routes.length} routes`
            : `${file} not available`,
        },
        res.ok ? JSON.stringify({ file, routes }, null, 1) : undefined,
      );
    } catch {
      signal?.throwIfAborted();
    }
  }

  // shortcut: REA is not installed in the sandbox yet, so code-level evidence is recorded as not observed; capture it once REA runs there.
  await add({
    kind: "code",
    tool: "rea",
    status: "not_observed",
    limits:
      "REA analysis of shipped JavaScript bundles is not available in this build",
    summary: `REA analysis of ${facts.scripts.length} script bundles not run`,
  });
  signal?.throwIfAborted();
  return { evidence, blobs };
}
