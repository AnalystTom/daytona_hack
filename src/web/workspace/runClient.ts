import { z } from "zod";
import { ReportDissection } from "../../shared/report";
import { OrchestratorEvent } from "./orchestrator";

// Client for the run API (/api/v1/runs), which forwards to the orchestrator.
export type RunCallError = {
  ok: false;
  error: "not_connected" | "not_found" | "access_required" | "failed";
  detail: string;
};
export type RunCallResult<T> = { ok: true; value: T } | RunCallError;

const CreatedRun = z.object({ id: z.string().min(1) });
const RunHistory = z.array(
  z.object({ id: z.string().min(1), createdAt: z.iso.datetime() }),
);
const SignIn = z.object({ liveViewUrl: z.url({ protocol: /^https$/ }) });
const ErrorBody = z.union([
  z.object({ message: z.string().min(1) }).transform((b) => b.message),
  z.object({ error: z.string().min(1) }).transform((b) => b.error),
]);

// Older pages kept the operator token in localStorage; visitors no longer need one.
try {
  localStorage.removeItem("reversy.operatorToken");
} catch {
  // Storage blocked: nothing was kept there.
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  parse: (response: Response) => Promise<T>,
  fetchImpl: typeof fetch,
): Promise<RunCallResult<T>> {
  const headers: Record<string, string> = {
    "X-Requested-With": "XMLHttpRequest",
  };
  if (method === "POST") headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    return {
      ok: false,
      error: "not_connected",
      detail: "Reversy's run service could not be reached.",
    };
  }
  if (response.ok) {
    try {
      return { ok: true, value: await parse(response) };
    } catch {
      return {
        ok: false,
        error: "failed",
        detail: "The run service sent a reply this page could not read.",
      };
    }
  }
  const json: unknown = await response.json().catch(() => undefined);
  const reason = ErrorBody.safeParse(json);
  const detail = reason.success ? reason.data : `HTTP ${response.status}`;
  if (response.status === 401) {
    return {
      ok: false,
      error: "access_required",
      detail:
        "Sign in in a new tab, then return to this workspace and try again. Keep this tab open.",
    };
  }
  if (response.status === 404) {
    return { ok: false, error: "not_found", detail };
  }
  if ([405, 501].includes(response.status)) {
    return {
      ok: false,
      error: "not_connected",
      detail: "The run service is not available yet.",
    };
  }
  return { ok: false, error: "failed", detail };
}

const runPath = (runId: string, action = "") =>
  `/api/v1/runs/${encodeURIComponent(runId)}${action && `/${action}`}`;

export function createRun(
  brief: { url: string; goal: string },
  fetchImpl: typeof fetch = fetch,
) {
  const start = () =>
    call(
      "POST",
      "/api/v1/runs",
      brief,
      async (r) => ({ runId: CreatedRun.parse(await r.json()).id }),
      fetchImpl,
    );
  return typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request("reversy.createRun", start)
    : start();
}

export function sendMessage(
  runId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
) {
  return call(
    "POST",
    runPath(runId, "messages"),
    { text },
    async () => undefined,
    fetchImpl,
  );
}

export function runAction(
  runId: string,
  action: "build" | "stop" | "variants" | "sign-in/resume" | "sign-in/skip",
  fetchImpl: typeof fetch = fetch,
) {
  return call(
    "POST",
    runPath(runId, action),
    {},
    async () => undefined,
    fetchImpl,
  );
}

export function promoteVariant(
  runId: string,
  variantId: string,
  fetchImpl: typeof fetch = fetch,
) {
  return call(
    "POST",
    runPath(runId, "promote"),
    { variantId },
    async () => undefined,
    fetchImpl,
  );
}

// Anchor's one-time live view, where the user signs in themselves; Reversy never sees the password.
export function startSignIn(runId: string, fetchImpl: typeof fetch = fetch) {
  return call(
    "POST",
    runPath(runId, "sign-in"),
    {},
    async (r) => SignIn.parse(await r.json()).liveViewUrl,
    fetchImpl,
  );
}

export function overrideVerdict(
  runId: string,
  override: { taskId: string; verdict: "approve" | "reject"; reason: string },
  fetchImpl: typeof fetch = fetch,
) {
  return call(
    "POST",
    runPath(runId, "override"),
    override,
    async () => undefined,
    fetchImpl,
  );
}

export function fetchRun(runId: string, fetchImpl: typeof fetch = fetch) {
  return call(
    "GET",
    runPath(runId),
    undefined,
    async (r) => CreatedRun.parse(await r.json()),
    fetchImpl,
  );
}

export function fetchRunHistory(fetchImpl: typeof fetch = fetch) {
  return call(
    "GET",
    "/api/v1/runs",
    undefined,
    async (r) => RunHistory.parse(await r.json()),
    fetchImpl,
  );
}

// Events after `since`, oldest first.
export async function fetchEvents(
  runId: string,
  since: number,
  fetchImpl: typeof fetch = fetch,
) {
  if (since === 0) {
    const run = await fetchRun(runId, fetchImpl);
    if (!run.ok) return run;
  }
  return call(
    "GET",
    `${runPath(runId, "events")}?since=${since}`,
    undefined,
    async (r) =>
      z
        .array(z.unknown())
        .parse(await r.json())
        .flatMap(validEvent),
    fetchImpl,
  );
}

// An evidence file, shown from a blob so a refused read becomes a notice rather than a broken image.
export function fetchEvidence(path: string, fetchImpl: typeof fetch = fetch) {
  return call("GET", path, undefined, (r) => r.blob(), fetchImpl);
}

const PreviewLink = z.object({ url: z.url({ protocol: /^https$/ }) });

// A short-lived signed link to the run's private preview.
export function fetchPreviewLink(
  runId: string,
  variantId?: string,
  fetchImpl: typeof fetch = fetch,
  attempt = 0,
) {
  return call(
    "GET",
    `${runPath(runId, "preview")}${variantId === undefined ? "" : `?variant=${encodeURIComponent(variantId)}&attempt=${attempt}`}`,
    undefined,
    async (r) => PreviewLink.parse(await r.json()).url,
    fetchImpl,
  );
}

const validEvent = (value: unknown) => {
  const event = OrchestratorEvent.safeParse(value);
  return event.success ? [event.data] : [];
};

export function saveReportEdit(
  runId: string,
  figureId: string,
  edit: { label: string; value: string },
  fetchImpl: typeof fetch = fetch,
) {
  return call(
    "POST",
    runPath(runId, "report-edit"),
    { figureId, edit },
    async (r) => ReportDissection.parse(await r.json()),
    fetchImpl,
  );
}
