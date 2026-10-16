import { z } from "zod";
import { OrchestratorEvent } from "./orchestrator";

// Client for the run API (/api/v1/runs), which forwards to the orchestrator.
// Every POST starts, steers or stops paid work, so it carries the operator token.

export type RunCallError = {
  ok: false;
  error: "not_connected" | "operator_token" | "failed";
  detail: string;
};
export type RunCallResult<T> = { ok: true; value: T } | RunCallError;

const CreatedRun = z.object({ id: z.string().min(1) });
const ErrorBody = z.union([
  z.object({ message: z.string().min(1) }).transform((b) => b.message),
  z.object({ error: z.string().min(1) }).transform((b) => b.error),
]);

const TOKEN_KEY = "reversy.operatorToken";

// shortcut: the operator token lives in this browser's localStorage until there is a login system.
export const operatorToken = {
  get(): string | undefined {
    try {
      return localStorage.getItem(TOKEN_KEY) || undefined;
    } catch {
      return undefined;
    }
  },
  set(token: string) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // Storage blocked: the token cannot be kept, and the next call asks again.
    }
  },
};

const tokenNeeded: RunCallError = {
  ok: false,
  error: "operator_token",
  detail:
    "Runs spend money, so only operators can start or steer them. Paste the operator token to continue.",
};

async function call<T>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  parse: (json: unknown) => T,
  fetchImpl: typeof fetch,
): Promise<RunCallResult<T>> {
  const headers: Record<string, string> = {};
  if (method === "POST") {
    const token = operatorToken.get();
    if (!token) return tokenNeeded;
    headers.authorization = `Bearer ${token}`;
    headers["content-type"] = "application/json";
  }
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
  const json: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    try {
      return { ok: true, value: parse(json) };
    } catch {
      return {
        ok: false,
        error: "failed",
        detail: "The run service sent a reply this page could not read.",
      };
    }
  }
  const reason = ErrorBody.safeParse(json);
  const detail = reason.success ? reason.data : `HTTP ${response.status}`;
  if (response.status === 401) {
    return {
      ok: false,
      error: "operator_token",
      detail: "The operator token was refused. Paste the current one.",
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
    (json) => ({ runId: CreatedRun.parse(json).id }),
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
    () => undefined,
    fetchImpl,
  );
}

export function runAction(
  runId: string,
  action: "build" | "stop",
  fetchImpl: typeof fetch = fetch,
) {
  return call("POST", runPath(runId, action), {}, () => undefined, fetchImpl);
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
    () => undefined,
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
    (json) => z.array(z.unknown()).parse(json).flatMap(validEvent),
    fetchImpl,
  );
}

const validEvent = (value: unknown) => {
  const event = OrchestratorEvent.safeParse(value);
  return event.success ? [event.data] : [];
};
