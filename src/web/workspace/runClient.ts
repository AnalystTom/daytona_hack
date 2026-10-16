import { z } from "zod";
import { OrchestratorEvent } from "./orchestrator";

// Client for the run API (/api/v1/runs), which forwards to the orchestrator.
// Runs spend money and hold the target's data, so every call carries the operator token.

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
    "Runs spend money, so only operators can start, steer or follow them. Paste the operator token to continue.",
};

async function call<T>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  parse: (response: Response) => Promise<T>,
  fetchImpl: typeof fetch,
): Promise<RunCallResult<T>> {
  const token = operatorToken.get();
  if (!token) return tokenNeeded;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
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
  action: "build" | "stop",
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

// An evidence file; <img> cannot send the token, so the page shows it from a blob.
export function fetchEvidence(path: string, fetchImpl: typeof fetch = fetch) {
  return call("GET", path, undefined, (r) => r.blob(), fetchImpl);
}

const validEvent = (value: unknown) => {
  const event = OrchestratorEvent.safeParse(value);
  return event.success ? [event.data] : [];
};
