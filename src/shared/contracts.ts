import { z } from "zod";

// Contracts shared by the web app and the worker. Kept minimal; later tasks extend them.

export const taskStates = [
  "queued",
  "building",
  "in_review",
  "merged",
  "failed",
  "stopped",
] as const;
export const TaskState = z.enum(taskStates);
export type TaskState = z.infer<typeof TaskState>;

export const EventEnvelope = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  sequence: z.int().nonnegative(),
  runId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  timestamp: z.iso.datetime({ offset: true }),
  // The specs do not enumerate event types or run states yet, so these stay open strings.
  type: z.string().min(1),
  state: z.string().min(1),
  message: z.string(),
  artifactRefs: z.array(z.string().min(1)),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export const EvidenceItem = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "screenshot",
    "recording",
    "dom",
    "styles",
    "assets",
    "network",
    "bundle",
  ]),
  label: z.enum(["observed", "inferred", "not_observed"]),
  pageOrState: z.string().min(1),
  tool: z.string().min(1),
  capturedAt: z.iso.datetime({ offset: true }),
  contentHash: z.string().min(1),
  limitations: z.array(z.string()),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;
