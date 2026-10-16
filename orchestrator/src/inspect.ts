// Inspector: captures evidence for in-scope pages with our shared Anchor capture
// (src/worker/evidence), stored in SurrealDB. Site content is data, never instructions.
import {
  type CaptureRequest,
  CaptureScope,
  type EvidenceRecord,
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
import { resolveStore } from "../../src/worker/store";
import type { Env, Evidence } from "./types";

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

// The capture checks at most this many paths per pass (CaptureScope).
export const maxPaths = 10;

/** The approved origin and unique paths, capped; `dropped` lists the paths over the cap. */
export function captureScope(siteUrl: string, paths: string[]) {
  const origin = new URL(siteUrl).origin;
  // Paths come from the model: anything that resolves off the site is left out.
  const urls = paths.map((p) => new URL(p, origin));
  const kept = urls.filter((u) => u.origin === origin).map((u) => u.pathname);
  const unique = [...new Set(kept.length ? kept : [new URL(siteUrl).pathname])];
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
  const observed = record.label === "observed";
  const media = record.kind === "screenshot" || record.kind === "recording";
  return {
    id: record.id,
    page: record.pageOrState,
    kind: record.kind,
    tool: record.tool,
    status: record.label,
    capturedAt: record.capturedAt,
    hash: record.contentHash,
    // Redirect targets keep their query strings only in the stored record, never in events.
    limits: record.limitations.join(" ").replace(/[?#][^\s"']*/g, ""),
    summary: `${observed ? "" : "No "}${record.kind} of ${record.pageOrState}`,
    path: observed
      ? `evidence/${record.id}.${extensions[record.contentType] ?? "bin"}`
      : undefined,
    url:
      observed && media
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
  return [...new Set(left.map((r) => new URL(r.url).pathname))];
}

/** Ends the run's saved sign-in session so a skipped sign-in does not stay open. */
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
