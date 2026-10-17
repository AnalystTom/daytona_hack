// REA code evidence: turns sandbox/rea-scan.mjs output into evidence items. Each finding keeps
// its bundle's SHA-256 and a source locator; static findings never prove runtime behaviour.
import { redactQuery } from "../../src/shared/evidence";
import type { Evidence } from "./types";

export interface ReaFinding {
  kind: "api" | "route" | "endpoint" | "storage" | "module";
  value: string;
  file: string;
  sha256: string;
  locator: string;
  state: "observed" | "inferred";
  mechanism?: string;
  format?: string;
  exports?: string[];
}

export type ReaScan =
  | {
      findings: ReaFinding[];
      omitted: number;
      truncated: boolean;
      limitations: string[];
    }
  | { error: string };

const LABELS: Record<ReaFinding["kind"], string> = {
  api: "API call",
  route: "Route",
  endpoint: "Endpoint",
  storage: "Storage",
  module: "Module",
};

// What REA's static reading never shows, whatever it found.
const STATIC_LIMITS =
  "static analysis of shipped bundles: calls and routes found in code were not executed or observed at runtime";

type Fields = Omit<Evidence, "id" | "page" | "capturedAt">;

/** One not_observed item: REA did not run, so code-level structure is unknown. */
export const reaNotObserved = (reason: string, bundles: number): Fields => ({
  kind: "code",
  tool: "rea",
  status: "not_observed",
  hash: "",
  limits: reason.slice(0, 300),
  summary: `REA analysis of ${bundles} script bundles not run`,
});

/**
 * Evidence fields for one scan; `files` maps the scanned file names to the bundle URLs they came from.
 * A failed or unreadable scan becomes one not_observed item with the reason.
 */
export function reaEvidence(
  scan: unknown,
  files: Record<string, string>,
): Fields[] {
  const bundles = Object.keys(files).length;
  if (!scan || typeof scan !== "object")
    return [reaNotObserved("REA returned no result", bundles)];
  if ("error" in scan)
    return [reaNotObserved(`REA failed: ${String(scan.error)}`, bundles)];
  const { findings, omitted, truncated, limitations } = scan as Extract<
    ReaScan,
    { findings: unknown }
  >;
  if (!Array.isArray(findings))
    return [reaNotObserved("REA returned no findings list", bundles)];
  const scanLimits = [
    STATIC_LIMITS,
    ...(truncated ? ["REA coverage was truncated"] : []),
    ...(omitted > 0 ? [`${omitted} further findings omitted`] : []),
    ...(Array.isArray(limitations) ? limitations.slice(0, 3) : []),
  ].join("; ");
  if (!findings.length)
    return [
      {
        kind: "code",
        tool: "rea",
        status: "not_observed",
        hash: "",
        limits: scanLimits,
        summary: `REA found no modules, routes or API calls in ${bundles} script bundles`,
      },
    ];
  return findings.map((f) => {
    const source = files[f.file] && redactQuery(files[f.file]);
    const detail = [
      f.mechanism && `via ${f.mechanism}`,
      f.format,
      f.exports?.length && `exports ${f.exports.join(", ")}`,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      kind: "code",
      tool: "rea",
      status: f.state === "observed" ? "observed" : "inferred",
      hash: f.sha256,
      locator: f.locator,
      limits: scanLimits,
      summary:
        `${LABELS[f.kind] ?? "Finding"} ${f.value}${detail ? ` (${detail})` : ""} in ${source ?? f.file}`.slice(
          0,
          400,
        ),
    };
  });
}

// Per-run bounds: a few bundles, a few megabytes, one short-lived sandbox for at most REA_SECONDS.
export const MAX_BUNDLES = 8;
const MAX_BUNDLE_BYTES = 4_000_000;
const MAX_TOTAL_BYTES = 12_000_000;
const REA_SECONDS = 120;
const REA_DIR = "/tmp/rea-bundles";

/** Script bundle URLs a page ships (script src and module preloads), absolute, deduplicated. */
export function scriptUrls(html: string, base: string, max = MAX_BUNDLES) {
  const urls = new Set<string>();
  const tags =
    /<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)|<link\b(?=[^>]*\brel\s*=\s*["']?modulepreload)[^>]*\bhref\s*=\s*["']?([^"'\s>]+)/gi;
  for (const m of html.matchAll(tags)) {
    try {
      const u = new URL((m[1] ?? m[2]).replace(/&amp;/g, "&"), base);
      if (u.protocol === "https:" || u.protocol === "http:") urls.add(u.href);
    } catch {}
    if (urls.size >= max) break;
  }
  return [...urls];
}

/** Downloads bundles within the byte caps; REA only parses .js/.mjs names, so each keeps one. */
export async function fetchBundles(urls: string[], signal?: AbortSignal) {
  const files: Record<string, string> = {};
  const contents: Record<string, ArrayBuffer> = {};
  const skipped: string[] = [];
  let total = 0;
  for (const [i, url] of urls.entries()) {
    signal?.throwIfAborted();
    try {
      const res = await fetch(url, {
        signal: AbortSignal.any([
          AbortSignal.timeout(15_000),
          ...(signal ? [signal] : []),
        ]),
      });
      const body = res.ok ? await res.arrayBuffer() : undefined;
      if (!body) skipped.push(`${redactQuery(url)} (HTTP ${res.status})`);
      else if (
        body.byteLength > MAX_BUNDLE_BYTES ||
        total + body.byteLength > MAX_TOTAL_BYTES
      )
        skipped.push(`${redactQuery(url)} (over the size cap)`);
      else {
        total += body.byteLength;
        const name = `${i}${new URL(url).pathname.endsWith(".mjs") ? ".mjs" : ".js"}`;
        files[name] = url;
        contents[name] = body;
      }
    } catch (e) {
      signal?.throwIfAborted();
      skipped.push(`${redactQuery(url)} (${String(e).slice(0, 80)})`);
    }
  }
  return { files, contents, skipped };
}

export interface ReaSandbox {
  create(opts: {
    snapshot?: string;
    labels?: Record<string, string>;
  }): Promise<{ id: string }>;
  remove(id: string): Promise<void>;
  writeFile(id: string, path: string, content: ArrayBuffer): Promise<void>;
  exec(
    id: string,
    command: string,
    opts?: { timeout?: number },
  ): Promise<{ exitCode: number; result: string }>;
}

/**
 * Code evidence for a page: fetch its bundles here (the sandbox cannot reach the site), scan them
 * with REA in a throwaway sandbox, then delete it. Never throws except on abort: any failure
 * becomes one not_observed item with the reason.
 */
export async function reaInspect(
  daytona: ReaSandbox,
  html: string,
  base: string,
  opts: { snapshot?: string; labels?: Record<string, string> },
  signal?: AbortSignal,
): Promise<Fields[]> {
  const urls = scriptUrls(html, base);
  if (!urls.length)
    return [reaNotObserved("the page ships no external script bundles", 0)];
  const { files, contents, skipped } = await fetchBundles(urls, signal);
  const note = skipped.length ? ` Skipped: ${skipped.join("; ")}.` : "";
  if (!Object.keys(files).length)
    return [reaNotObserved(`no script bundle could be fetched.${note}`, 0)];
  let id: string | undefined;
  try {
    id = (await daytona.create(opts)).id;
    for (const [name, body] of Object.entries(contents)) {
      signal?.throwIfAborted();
      await daytona.writeFile(id, `${REA_DIR}/${name}`, body);
    }
    signal?.throwIfAborted();
    const r = await daytona.exec(
      id,
      `node /opt/reversy/sandbox/rea-scan.mjs ${REA_DIR} ${REA_SECONDS}`,
      { timeout: REA_SECONDS + 30 },
    );
    let scan: unknown;
    try {
      scan = JSON.parse(r.result.trim().split("\n").at(-1) ?? "");
    } catch {
      scan = { error: `scan exited ${r.exitCode}: ${r.result.slice(-200)}` };
    }
    return reaEvidence(scan, files).map((e) =>
      note ? { ...e, limits: `${e.limits};${note}`.slice(0, 600) } : e,
    );
  } catch (e) {
    signal?.throwIfAborted();
    return [
      reaNotObserved(
        `REA sandbox failed: ${String((e as Error)?.message ?? e)}`,
        Object.keys(files).length,
      ),
    ];
  } finally {
    if (id) await daytona.remove(id).catch(() => {});
  }
}
