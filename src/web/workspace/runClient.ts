import { z } from "zod";
import { OrchestratorEvent } from "./orchestrator";

// Client for the run API (/api/v1/runs), which forwards to the orchestrator.
// Runs spend money and hold the target's data, so every call needs the operator session cookie,
// which only the server can read (POST /api/v1/session sets it).

export type RunCallError = {
  ok: false;
  error: "not_connected" | "operator_token" | "failed";
  detail: string;
};
export type RunCallResult<T> = { ok: true; value: T } | RunCallError;

const CreatedRun = z.object({ id: z.string().min(1) });
const SignIn = z.object({ liveViewUrl: z.url({ protocol: /^https$/ }) });
const ErrorBody = z.union([
  z.object({ message: z.string().min(1) }).transform((b) => b.message),
  z.object({ error: z.string().min(1) }).transform((b) => b.error),
]);

// Older pages kept the operator token in localStorage; the HttpOnly session cookie replaces it.
try {
  localStorage.removeItem("reversy.operatorToken");
} catch {
  // Storage blocked: nothing was kept there.
}

// Swaps the operator token for the session cookie; the token itself is never stored.
export async function signIn(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RunCallResult<undefined>> {
  return call(
    "POST",
    "/api/v1/session",
    { token },
    async () => undefined,
    fetchImpl,
  );
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  parse: (response: Response) => Promise<T>,
  fetchImpl: typeof fetch,
): Promise<RunCallResult<T>> {
  const headers: Record<string, string> = {};
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
      error: "operator_token",
      detail:
        path === "/api/v1/session"
          ? "The operator token was refused. Paste the current one."
          : "Runs spend money, so only operators can start, steer or follow them. Paste the operator token to continue.",
    };
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
  return call(
    "POST",
    "/api/v1/runs",
    brief,
    async (r) => ({ runId: CreatedRun.parse(await r.json()).id }),
    fetchImpl,
  );
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
  action: "build" | "stop" | "sign-in/resume" | "sign-in/skip",
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

// Events after `since`, oldest first.
export function fetchEvents(
  runId: string,
  since: number,
  fetchImpl: typeof fetch = fetch,
) {
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
  fetchImpl: typeof fetch = fetch,
) {
  return call(
    "GET",
    runPath(runId, "preview"),
    undefined,
    async (r) => PreviewLink.parse(await r.json()).url,
    fetchImpl,
  );
}

const validEvent = (value: unknown) => {
  const event = OrchestratorEvent.safeParse(value);
  return event.success ? [event.data] : [];
};
