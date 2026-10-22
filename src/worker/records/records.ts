import { z } from "zod";
import type { RunStore } from "../store/types";

// One orchestrator run event (orchestrator/src/types.ts RunRecord), written to SurrealDB.
const RunRecord = z.object({
  run: z.object({
    id: z.string().min(1).max(100),
    url: z.string().min(1),
    goal: z.string(),
    startedAt: z.iso.datetime({ offset: true }),
  }),
  event: z.object({
    seq: z.int().positive(),
    ts: z.iso.datetime({ offset: true }),
    type: z.string().min(1),
    data: z.unknown(),
  }),
});

// The fields a record is indexed by; the full event data is kept with it.
const Data = z.object({
  id: z.string().optional(),
  role: z.string().optional(),
  status: z.string().optional(),
  phase: z.string().optional(),
  verdict: z.string().optional(),
  pass: z.boolean().optional(),
  text: z.string().optional(),
  summary: z.string().optional(),
  message: z.string().optional(),
  reason: z.string().optional(),
});

export async function recordRunEvent(store: RunStore, input: unknown) {
  const { run, event } = RunRecord.parse(input);
  if (!(await store.getRun(run.id))) {
    await store.createRun({
      id: run.id,
      url: run.url,
      goal: run.goal || run.url,
      status: "active",
      createdAt: run.startedAt,
      updatedAt: run.startedAt,
      specApprovedAt: null,
    });
  }
  const parsed = Data.safeParse(event.data);
  const data = parsed.success ? parsed.data : {};
  const pass =
    data.pass === undefined ? undefined : data.pass ? "pass" : "fail";
  const eventId = String(event.seq);
  const { duplicates } = await store.appendEvents(run.id, [
    {
      schemaVersion: 1,
      eventId,
      sequence: event.seq,
      runId: run.id,
      // Only task events set a task's state; reviews and verdicts name their task in data.
      taskId: event.type === "task" ? data.id : undefined,
      timestamp: event.ts,
      type: event.type,
      state: data.status ?? data.phase ?? data.verdict ?? pass ?? event.type,
      message: (
        data.text ??
        data.summary ??
        data.message ??
        data.reason ??
        ""
      ).slice(0, 2000),
      artifactRefs: [],
      // Not part of the envelope schema: stored with it so the record keeps the whole event.
      ...{ data: event.data },
    },
  ]);
  if (duplicates.length > 0) return;

  // Not `<run>_<seq>`: SurrealDB reads a string starting with a UUID as that bare UUID.
  const id = `e${eventId}_${run.id}`;
  if (event.type === "chat" && data.role === "user" && data.text) {
    await store.recordSteering({
      id,
      runId: run.id,
      kind: "message",
      text: data.text,
      eventId,
      createdAt: event.ts,
    });
  }
  if (event.type === "phase" && data.phase) {
    if (data.phase === "inspecting") {
      await store.recordApproval({
        id,
        runId: run.id,
        kind: "spec",
        eventId,
        createdAt: event.ts,
      });
    }
    if (data.phase === "stopped" && data.reason === undefined) {
      await store.recordSteering({
        id,
        runId: run.id,
        kind: "stop",
        text: "",
        eventId,
        createdAt: event.ts,
      });
    }
    await store.updateRun(run.id, {
      updatedAt: event.ts,
      ...(["stopped", "failed"].includes(data.phase)
        ? { status: "stopped" as const }
        : {}),
      ...(data.phase === "inspecting" ? { specApprovedAt: event.ts } : {}),
    });
  }
}
