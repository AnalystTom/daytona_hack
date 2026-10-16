import { z } from "zod";

// Client for the run API (POST /api/v1/runs and its message endpoint), built in a parallel task.
// Until those routes exist the Worker answers 404 and every call reports "not_connected".

export type RunCallError = {
  ok: false;
  error: "not_connected" | "sign_in_needed" | "failed";
  detail: string;
};
export type RunCallResult<T> = { ok: true; value: T } | RunCallError;

const CreatedRun = z.object({ runId: z.string().min(1) });
const ErrorBody = z.object({ error: z.string().min(1) });

async function post<T>(
  path: string,
  body: unknown,
  parse: (json: unknown) => T,
  fetchImpl: typeof fetch,
): Promise<RunCallResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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
  const detail = reason.success ? reason.data.error : `HTTP ${response.status}`;
  if ([404, 405, 501].includes(response.status)) {
    return {
      ok: false,
      error: "not_connected",
      detail: "The run service is not available yet.",
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: "sign_in_needed", detail };
  }
  return { ok: false, error: "failed", detail };
}

export function createRun(brief: string, fetchImpl: typeof fetch = fetch) {
  return post(
    "/api/v1/runs",
    { brief },
    (json) => CreatedRun.parse(json),
    fetchImpl,
  );
}

export function sendMessage(
  runId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
) {
  return post(
    `/api/v1/runs/${encodeURIComponent(runId)}/messages`,
    { text },
    () => undefined,
    fetchImpl,
  );
}
