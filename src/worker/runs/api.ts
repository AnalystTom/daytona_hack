import { z } from "zod";
import type { EventEnvelope } from "../../shared/contracts";
import {
  type ApiError,
  BridgeEventsRequest,
  ChatMessageRequest,
  CreateRunRequest,
  type MemoryEntry,
  MemoryKind,
  MemoryWriteRequest,
  type Run,
  runEventTypes,
} from "../../shared/runs";
import { runBridgeToken } from "../daytona/bridge-token";
import { resolveStore, type StoreEnv } from "../store";
import { type RunStore, StoreError } from "../store/types";
import { defaultStreamOptions, eventStream, type StreamOptions } from "./sse";
import { checkTargetUrl } from "./url";

export interface RunsEnv extends StoreEnv {
  // Worker-wide secret; a bridge sends only its run's derived token (`runBridgeToken`).
  BRIDGE_TOKEN?: string;
  // Interim operator secret required to create runs, sent as `Authorization: Bearer <token>`.
  OPERATOR_TOKEN?: string;
}

export class Failure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const maxBodyBytes = 1_000_000;
export const notConfigured = (missing: string[]) =>
  new Failure(
    503,
    "not_configured",
    `Missing Worker bindings: ${missing.join(", ")}.`,
  );

// Handles everything under /api/v1.
export async function handleRunsApi(
  request: Request,
  env: RunsEnv,
  streamOptions: StreamOptions = defaultStreamOptions,
  store?: RunStore,
): Promise<Response> {
  try {
    return await route(request, env, streamOptions, store);
  } catch (error) {
    return errorResponse(request, error);
  }
}

// Turns a thrown error into the API's error body; unexpected errors are logged, not shown.
export function errorResponse(request: Request, error: unknown): Response {
  const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
  const failure =
    error instanceof Failure
      ? error
      : error instanceof StoreError
        ? new Failure(
            503,
            "store_unavailable",
            "Storage is temporarily unavailable.",
            true,
          )
        : new Failure(500, "internal_error", "Internal error.");
  if (!(error instanceof Failure)) console.error(requestId, error);
  const body: ApiError = {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    requestId,
  };
  return Response.json(body, { status: failure.status });
}

async function route(
  request: Request,
  env: RunsEnv,
  streamOptions: StreamOptions,
  injectedStore: RunStore | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  const [collection, runId, action, ...rest] = url.pathname
    .slice("/api/v1/".length)
    .split("/");
  const key = `${request.method} ${action ?? (runId ? ":id" : "")}`;
  if (collection !== "runs" || rest.length > 0 || runId === "") {
    throw new Failure(404, "not_found", "No such route.");
  }
  const handler = runId === undefined ? rootRoutes[key] : runRoutes[key];
  if (!handler) throw new Failure(404, "not_found", "No such route.");

  if (bridgeRoutes.has(key))
    await checkToken(request, env, "BRIDGE_TOKEN", runId);
  if (key === "POST ") await checkToken(request, env, "OPERATOR_TOKEN");
  const resolved = injectedStore ? { store: injectedStore } : resolveStore(env);
  if ("missing" in resolved) throw notConfigured(resolved.missing);
  const { store } = resolved;

  if (runId === undefined) return handler(request, store, null, streamOptions);
  const run = await store.getRun(runId);
  if (!run) throw new Failure(404, "run_not_found", `Run ${runId} not found.`);
  return handler(request, store, run, streamOptions);
}

type Handler = (
  request: Request,
  store: RunStore,
  run: Run | null,
  streamOptions: StreamOptions,
) => Promise<Response>;

const rootRoutes: Record<string, Handler> = {
  "POST ": async (request, store) => {
    const body = await readJson(request, CreateRunRequest);
    const target = checkTargetUrl(body.url);
    if ("error" in target) throw new Failure(400, "invalid_url", target.error);
    const now = new Date().toISOString();
    const run: Run = {
      id: crypto.randomUUID(),
      url: target.url,
      goal: body.goal,
      status: "active",
      createdAt: now,
      updatedAt: now,
      specApprovedAt: null,
    };
    await store.createRun(run);
    await emit(store, run, runEventTypes.created, run.goal);
    return Response.json({ runId: run.id, run }, { status: 201 });
  },
};

const runRoutes: Record<string, Handler> = {
  "GET :id": async (_request, store, run) => {
    const current = run as Run;
    return Response.json({
      run: current,
      tasks: await store.listTasks(current.id),
    });
  },

  "POST messages": async (request, store, run) => {
    const current = requireActive(run);
    const { text } = await readJson(request, ChatMessageRequest);
    const eventId = crypto.randomUUID();
    await store.recordSteering({
      id: crypto.randomUUID(),
      runId: current.id,
      kind: "message",
      text,
      eventId,
      createdAt: new Date().toISOString(),
    });
    const event = await emit(
      store,
      current,
      runEventTypes.message,
      text,
      eventId,
    );
    return Response.json({ event }, { status: 202 });
  },

  "GET events": async (request, store, run, streamOptions) => {
    const lastEventId = request.headers.get("last-event-id") ?? "0";
    if (!/^\d+$/.test(lastEventId)) {
      throw new Failure(
        400,
        "invalid_last_event_id",
        "Last-Event-ID must be an event sequence number.",
      );
    }
    const stream = eventStream(
      store,
      (run as Run).id,
      Number(lastEventId),
      streamOptions,
    );
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  },

  "POST events": async (request, store, run) => {
    const runId = (run as Run).id;
    const body = await readJson(request, BridgeEventsRequest);
    const events = Array.isArray(body) ? body : [body];
    if (events.some((event) => event.runId !== runId)) {
      throw new Failure(
        400,
        "run_mismatch",
        `Every event must have runId ${runId}.`,
      );
    }
    // Within a batch the producer's sequence sets the order; the store assigns the stored sequence.
    events.sort((a, b) => a.sequence - b.sequence);
    return Response.json(await store.appendEvents(runId, events));
  },

  "POST memory": async (request, store, run) => {
    const body = await readJson(request, MemoryWriteRequest);
    const entry: MemoryEntry = {
      ...body,
      id: crypto.randomUUID(),
      runId: (run as Run).id,
      createdAt: new Date().toISOString(),
    };
    await store.writeMemory(entry);
    return Response.json({ entry }, { status: 201 });
  },

  "GET memory": async (request, store, run) => {
    const kind = new URL(request.url).searchParams.get("kind");
    const parsed = MemoryKind.optional().safeParse(kind ?? undefined);
    if (!parsed.success) {
      throw new Failure(
        400,
        "invalid_request",
        "kind must be observation or decision.",
      );
    }
    return Response.json({
      entries: await store.readMemory((run as Run).id, parsed.data),
    });
  },

  "POST approve-spec": async (_request, store, run) => {
    const current = requireActive(run);
    const now = new Date().toISOString();
    const eventId = crypto.randomUUID();
    await store.recordApproval({
      id: crypto.randomUUID(),
      runId: current.id,
      kind: "spec",
      eventId,
      createdAt: now,
    });
    await store.updateRun(current.id, { specApprovedAt: now, updatedAt: now });
    const updated = (await store.getRun(current.id)) as Run;
    await emit(
      store,
      updated,
      runEventTypes.specApproved,
      "Spec approved.",
      eventId,
    );
    return Response.json({ run: updated });
  },

  "POST stop": async (_request, store, run) => {
    const current = run as Run;
    if (current.status === "stopped") return Response.json({ run: current });
    const now = new Date().toISOString();
    const eventId = crypto.randomUUID();
    await store.recordSteering({
      id: crypto.randomUUID(),
      runId: current.id,
      kind: "stop",
      text: "Stop requested by the user.",
      eventId,
      createdAt: now,
    });
    await store.updateRun(current.id, { status: "stopped", updatedAt: now });
    const updated = (await store.getRun(current.id)) as Run;
    await emit(store, updated, runEventTypes.stopped, "Run stopped.", eventId);
    return Response.json({ run: updated });
  },
};

const bridgeRoutes = new Set(["POST events", "POST memory", "GET memory"]);

function requireActive(run: Run | null): Run {
  const current = run as Run;
  if (current.status !== "active") {
    throw new Failure(409, "run_stopped", `Run ${current.id} is stopped.`);
  }
  return current;
}

async function emit(
  store: RunStore,
  run: Run,
  type: string,
  message: string,
  eventId: string = crypto.randomUUID(),
): Promise<EventEnvelope> {
  const event: EventEnvelope = {
    schemaVersion: 1,
    eventId,
    sequence: 0,
    runId: run.id,
    timestamp: new Date().toISOString(),
    type,
    state: run.status,
    message,
    artifactRefs: [],
  };
  const { stored } = await store.appendEvents(run.id, [event]);
  return stored[0] ?? event;
}

export async function readJson<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  // The header check refuses big bodies before they are read; the length check catches chunked ones.
  const declared = Number(request.headers.get("content-length") ?? 0);
  const text = declared > maxBodyBytes ? "" : await request.text();
  if (declared > maxBodyBytes || text.length > maxBodyBytes) {
    throw new Failure(
      413,
      "payload_too_large",
      "The request body is too large.",
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Failure(
      400,
      "invalid_json",
      "The request body is not valid JSON.",
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Failure(400, "invalid_request", z.prettifyError(parsed.error));
  }
  return parsed.data;
}

export async function checkToken(
  request: Request,
  env: Pick<RunsEnv, "BRIDGE_TOKEN" | "OPERATOR_TOKEN">,
  binding: "BRIDGE_TOKEN" | "OPERATOR_TOKEN",
  runId?: string,
) {
  const secret = env[binding];
  if (!secret) throw notConfigured([binding]);
  // A bridge holds only its run's derived token, never the Worker-wide secret.
  const token =
    runId === undefined ? secret : await runBridgeToken(secret, runId);
  const given = request.headers.get("authorization") ?? "";
  // Comparing digests keeps the comparison time independent of the secret.
  const [a, b] = await Promise.all(
    [given, `Bearer ${token}`].map((value) =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
  const same = new Uint8Array(a as ArrayBuffer).every(
    (byte, i) => byte === new Uint8Array(b as ArrayBuffer)[i],
  );
  if (!same) {
    throw new Failure(401, "unauthorized", "Missing or wrong bearer token.");
  }
}
