import { z } from "zod";
import { EventEnvelope } from "./contracts";

// Contracts for the run API (`/api/v1/runs`), shared by the web app, the sandbox bridge and the worker.

export const runStatuses = ["active", "stopped"] as const;
export const RunStatus = z.enum(runStatuses);
export type RunStatus = z.infer<typeof RunStatus>;

export const Run = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  goal: z.string().min(1),
  status: RunStatus,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  specApprovedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Run = z.infer<typeof Run>;

// A task as last reported by the bridge: the state of the newest event carrying its taskId.
export const RunTask = z.object({
  taskId: z.string().min(1),
  state: z.string().min(1),
  updatedAt: z.iso.datetime({ offset: true }),
  lastEventId: z.string().min(1),
});
export type RunTask = z.infer<typeof RunTask>;

export const CreateRunRequest = z.object({
  url: z.string().trim().min(1).max(2048),
  goal: z.string().trim().min(1).max(4000),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

export const ChatMessageRequest = z.object({
  text: z.string().trim().min(1).max(10000),
});
export type ChatMessageRequest = z.infer<typeof ChatMessageRequest>;

// The bridge posts one envelope or a batch; the API assigns the stored sequence in arrival order.
export const BridgeEventsRequest = z.union([
  EventEnvelope,
  z.array(EventEnvelope).min(1).max(500),
]);
export type BridgeEventsRequest = z.infer<typeof BridgeEventsRequest>;

// Event types the API itself emits onto a run's stream.
export const runEventTypes = {
  created: "run.created",
  message: "chat.message",
  specApproved: "spec.approved",
  stopped: "run.stopped",
} as const;

export const memoryKinds = ["observation", "decision"] as const;
export const MemoryKind = z.enum(memoryKinds);
export type MemoryKind = z.infer<typeof MemoryKind>;

// Agent Memory: what Firstmate observed or decided, with the sources (evidence IDs, event IDs, URLs) behind it.
export const MemoryWriteRequest = z.object({
  kind: MemoryKind,
  content: z.string().trim().min(1).max(20000),
  sources: z.array(z.string().min(1).max(2048)).min(1).max(100),
});
export type MemoryWriteRequest = z.infer<typeof MemoryWriteRequest>;

export const MemoryEntry = MemoryWriteRequest.extend({
  id: z.string().min(1),
  runId: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

export const ApiError = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  requestId: z.string().min(1),
});
export type ApiError = z.infer<typeof ApiError>;
