import { z } from "zod";
import { fromBase64, toBase64 } from "../evidence/store";
import { Failure } from "../runs/api";

// The public example is a saved copy of one finished run: its events and captured media,
// kept in SurrealDB so it outlives the orchestrator's Durable Object.

export const EXAMPLE_ID = /^[\w-]{1,100}$/;
const FINISHED = ["done", "stopped", "failed"];

const Event = z.object({
  seq: z.int().positive(),
  ts: z.string(),
  type: z.string(),
  data: z.unknown(),
});
const RunState = z.object({
  id: z.string(),
  phase: z.string(),
  spec: z.object({ url: z.string() }),
  sandboxId: z.string().optional(),
  previewUrl: z.string().optional(),
});
const MediaEvidence = z.object({
  id: z.string().regex(EXAMPLE_ID),
  kind: z.enum(["screenshot", "recording"]),
  url: z.string(),
  status: z.string().optional(),
});

export const Snapshot = z.object({
  runId: z.string().regex(EXAMPLE_ID),
  target: z.string(),
  phase: z.string(),
  // When the run's last event happened, and when this copy was saved.
  finishedAt: z.string(),
  savedAt: z.string(),
  events: z.array(Event),
  // Evidence ids with a stored file.
  media: z.array(z.string().regex(EXAMPLE_ID)),
});
export type Snapshot = z.infer<typeof Snapshot>;

export type MediaFile = { contentType: string; bytes: Uint8Array };

// A key-value table in SurrealDB; the example is its only user.
export interface ExampleStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export function surrealExampleStore(db: {
  query(sql: string, vars?: Record<string, unknown>): Promise<unknown[]>;
}): ExampleStore {
  return {
    async get(key) {
      const [rows] = await db.query(
        "SELECT VALUE value FROM type::record('example', $key)",
        { key },
      );
      return (rows as unknown[] | undefined)?.[0];
    },
    async put(key, value) {
      await db.query(
        "UPSERT type::record('example', $key) CONTENT { value: $value } RETURN NONE",
        { key, value },
      );
    },
  };
}

// Reads a finished run from the orchestrator. The sandbox id and preview link are left out:
// the example never reaches the run's sandbox.
export async function exportRun(
  orchestrator: Fetcher,
  runId: string,
  now = new Date(),
): Promise<{ snapshot: Snapshot; files: Map<string, MediaFile> }> {
  const get = async (path: string) => {
    const response = await orchestrator.fetch(
      `https://orchestrator/runs/${runId}${path}`,
    );
    if (!response.ok) {
      throw new Failure(
        502,
        "orchestrator_error",
        `The orchestrator answered ${response.status} for ${path || "the run"}.`,
      );
    }
    return response;
  };
  const text = await (await get("")).text();
  // A run id the orchestrator never saw answers 200 with an empty body.
  if (text === "") {
    throw new Failure(404, "run_not_found", `Run ${runId} not found.`);
  }
  const state = RunState.parse(JSON.parse(text));
  if (!FINISHED.includes(state.phase)) {
    throw new Failure(
      409,
      "run_not_finished",
      `Run ${runId} is ${state.phase}; only a finished run can be the example.`,
    );
  }
  let events = z
    .array(Event)
    .parse(await (await get("/events?since=0")).json());
  let json = JSON.stringify(events, (key, value) =>
    key === "sandboxId" ? undefined : value,
  );
  for (const secret of [state.previewUrl, state.sandboxId]) {
    if (secret) json = json.replaceAll(secret, "[not kept]");
  }
  // Signed preview links carry a token instead of the sandbox id: drop every port-prefixed
  // sandbox host (https://3000-<id or token>.<proxy>/...).
  json = json.replace(/https?:\/\/\d{2,5}-[^\s"\\]+/g, "[not kept]");
  events = JSON.parse(json);

  const files = new Map<string, MediaFile>();
  const evidence = new Map<string, z.infer<typeof MediaEvidence>>();
  for (const event of events) {
    if (event.type !== "evidence") continue;
    const identity = z.object({ id: z.string() }).safeParse(event.data);
    if (identity.success) evidence.delete(identity.data.id);
    const media = MediaEvidence.safeParse(event.data);
    if (media.success && media.data.status !== "not_observed")
      evidence.set(media.data.id, media.data);
  }
  for (const media of evidence.values()) {
    const response = await get(`/evidence/${media.id}`);
    files.set(media.id, {
      contentType:
        response.headers.get("content-type") ??
        (media.kind === "screenshot" ? "image/png" : "video/mp4"),
      bytes: new Uint8Array(await response.arrayBuffer()),
    });
  }
  const last = events.at(-1);
  return {
    snapshot: {
      runId,
      target: state.spec.url,
      phase: state.phase,
      finishedAt: last?.ts ?? now.toISOString(),
      savedAt: now.toISOString(),
      events,
      media: [...files.keys()],
    },
    files,
  };
}

// SurrealDB RPC bodies are capped at 4 MiB; 2 MiB of bytes is under 3 MiB as base64.
const CHUNK_BYTES = 2 * 1024 * 1024;
const CURRENT = "current";
const fileKey = (runId: string, id: string) => `file/${runId}/${id}`;
const MediaMeta = z.object({
  contentType: z.string(),
  chunks: z.int().nonnegative(),
});

// Media first, the snapshot last: the example switches runs only once every file is stored.
export async function saveSnapshot(
  store: ExampleStore,
  snapshot: Snapshot,
  files: Map<string, MediaFile>,
) {
  for (const [id, { contentType, bytes }] of files) {
    const key = fileKey(snapshot.runId, id);
    const chunks = Math.ceil(bytes.length / CHUNK_BYTES);
    for (let i = 0; i < chunks; i++) {
      await store.put(
        `${key}/${i}`,
        toBase64(bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)),
      );
    }
    await store.put(key, { contentType, chunks });
  }
  // Kept as JSON text: SurrealDB would turn the events' date strings into datetimes.
  await store.put(CURRENT, JSON.stringify(snapshot));
}

export async function loadSnapshot(
  store: ExampleStore,
): Promise<Snapshot | null> {
  const text = await store.get(CURRENT);
  return typeof text === "string" ? Snapshot.parse(JSON.parse(text)) : null;
}

export async function loadMedia(
  store: ExampleStore,
  runId: string,
  id: string,
): Promise<MediaFile | null> {
  const key = fileKey(runId, id);
  const meta = MediaMeta.safeParse(await store.get(key));
  if (!meta.success) return null;
  const parts: Uint8Array[] = [];
  for (let i = 0; i < meta.data.chunks; i++) {
    const part = await store.get(`${key}/${i}`);
    if (typeof part !== "string") return null;
    parts.push(fromBase64(part));
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { contentType: meta.data.contentType, bytes };
}
