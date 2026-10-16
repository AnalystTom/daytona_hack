import type { EventEnvelope } from "../../shared/contracts";
import type { MemoryEntry, MemoryKind, Run, RunTask } from "../../shared/runs";
import type { AppendResult, Approval, RunStore, Steering } from "./types";

interface RunRecords {
  run: Run;
  events: EventEnvelope[];
  eventIds: Set<string>;
  tasks: Map<string, RunTask>;
  steering: Steering[];
  approvals: Approval[];
  memory: MemoryEntry[];
}

// In-process store for local dev and tests only; nothing survives the isolate.
export class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, RunRecords>();

  private records(runId: string): RunRecords {
    const records = this.runs.get(runId);
    if (!records) throw new Error(`Run ${runId} does not exist`);
    return records;
  }

  async createRun(run: Run) {
    this.runs.set(run.id, {
      run: structuredClone(run),
      events: [],
      eventIds: new Set(),
      tasks: new Map(),
      steering: [],
      approvals: [],
      memory: [],
    });
  }

  async getRun(runId: string) {
    const records = this.runs.get(runId);
    return records ? structuredClone(records.run) : null;
  }

  async updateRun(runId: string, patch: Partial<Omit<Run, "id">>) {
    Object.assign(this.records(runId).run, structuredClone(patch));
  }

  async appendEvents(
    runId: string,
    events: EventEnvelope[],
  ): Promise<AppendResult> {
    const records = this.records(runId);
    const result: AppendResult = { stored: [], duplicates: [] };
    for (const event of events) {
      if (records.eventIds.has(event.eventId)) {
        result.duplicates.push(event.eventId);
        continue;
      }
      const stored = {
        ...structuredClone(event),
        sequence: records.events.length + 1,
      };
      records.events.push(stored);
      records.eventIds.add(event.eventId);
      if (event.taskId) {
        records.tasks.set(event.taskId, {
          taskId: event.taskId,
          state: event.state,
          updatedAt: event.timestamp,
          lastEventId: event.eventId,
        });
      }
      result.stored.push(structuredClone(stored));
    }
    return result;
  }

  async listEvents(runId: string, afterSequence: number, limit: number) {
    const events = this.runs.get(runId)?.events ?? [];
    return structuredClone(
      events.filter((e) => e.sequence > afterSequence).slice(0, limit),
    );
  }

  async listTasks(runId: string) {
    const tasks = [...(this.runs.get(runId)?.tasks.values() ?? [])];
    return structuredClone(
      tasks.sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
    );
  }

  async recordSteering(steering: Steering) {
    this.records(steering.runId).steering.push(structuredClone(steering));
  }

  async recordApproval(approval: Approval) {
    this.records(approval.runId).approvals.push(structuredClone(approval));
  }

  async writeMemory(entry: MemoryEntry) {
    this.records(entry.runId).memory.push(structuredClone(entry));
  }

  async readMemory(runId: string, kind?: MemoryKind) {
    const memory = this.runs.get(runId)?.memory ?? [];
    return structuredClone(memory.filter((m) => !kind || m.kind === kind));
  }
}
