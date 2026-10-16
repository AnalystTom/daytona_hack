import type { EventEnvelope } from "../../shared/contracts";
import type { MemoryEntry, MemoryKind, Run, RunTask } from "../../shared/runs";

export interface Steering {
  id: string;
  runId: string;
  kind: "message" | "stop";
  text: string;
  eventId: string;
  createdAt: string;
}

export interface Approval {
  id: string;
  runId: string;
  kind: "spec";
  eventId: string;
  createdAt: string;
}

export interface AppendResult {
  // Newly stored events, with the sequence the store assigned.
  stored: EventEnvelope[];
  // Event IDs already stored for the run; these were ignored.
  duplicates: string[];
}

// Everything a run records. The run must exist before anything else is written for it.
export interface RunStore {
  createRun(run: Run): Promise<void>;
  getRun(runId: string): Promise<Run | null>;
  // Changes only the given fields, so concurrent updates of different fields both land.
  updateRun(runId: string, patch: Partial<Omit<Run, "id">>): Promise<void>;
  // Stores events in the given order, assigning each new one the run's next sequence (1, 2, ...).
  // An event with a taskId also updates that task's record.
  appendEvents(runId: string, events: EventEnvelope[]): Promise<AppendResult>;
  listEvents(
    runId: string,
    afterSequence: number,
    limit: number,
  ): Promise<EventEnvelope[]>;
  listTasks(runId: string): Promise<RunTask[]>;
  recordSteering(steering: Steering): Promise<void>;
  recordApproval(approval: Approval): Promise<void>;
  writeMemory(entry: MemoryEntry): Promise<void>;
  readMemory(runId: string, kind?: MemoryKind): Promise<MemoryEntry[]>;
}

// A storage failure the caller can retry (network, SurrealDB error, transaction conflict).
export class StoreError extends Error {}
