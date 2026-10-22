import { EventEnvelope } from "../../shared/contracts";
import { MemoryEntry, type MemoryKind, Run, RunTask } from "../../shared/runs";
import {
  type AppendResult,
  type Approval,
  type RunStore,
  type Steering,
  StoreError,
} from "./types";

export class D1RunStore implements RunStore {
  constructor(
    readonly db: D1Database,
    readonly blobs?: R2Bucket,
  ) {}

  statement(sql: string, ...values: unknown[]) {
    return this.db.prepare(sql).bind(...values);
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]) {
    try {
      return await this.db.batch<T>(statements);
    } catch (error) {
      throw new StoreError(`D1 storage failed: ${String(error)}`);
    }
  }

  async rows<T = Record<string, unknown>>(
    sql: string,
    ...values: unknown[]
  ): Promise<T[]> {
    const [result] = await this.batch<T>([this.statement(sql, ...values)]);
    return result?.results ?? [];
  }

  async createRun(run: Run) {
    await this.rows(
      "INSERT INTO run(id, data) VALUES (?, ?)",
      run.id,
      JSON.stringify(run),
    );
  }

  async getRun(runId: string) {
    const [row] = await this.rows<{ data: string }>(
      "SELECT data FROM run WHERE id=?",
      runId,
    );
    return row ? Run.parse(JSON.parse(row.data)) : null;
  }

  async updateRun(runId: string, patch: Partial<Omit<Run, "id">>) {
    // json_set preserves explicit nulls and merges concurrent updates of different fields.
    const entries = Object.entries(patch).filter(
      ([key, value]) => key !== "id" && value !== undefined,
    );
    if (!entries.length) return;
    await this.rows(
      `UPDATE run SET data=json_set(data, ${entries.map(() => "?, json(?)").join(",")}) WHERE id=?`,
      ...entries.flatMap(([key, value]) => [`$.${key}`, JSON.stringify(value)]),
      runId,
    );
  }

  async appendEvents(
    runId: string,
    events: EventEnvelope[],
  ): Promise<AppendResult> {
    const seen = new Set<string>();
    const unique = events.filter(
      (e) => !seen.has(e.eventId) && seen.add(e.eventId),
    );
    if (!unique.length) return { stored: [], duplicates: [] };
    // D1 serializes the whole batch. The task trigger runs only for newly inserted events.
    const results = await this.batch<{ envelope: string; sequence: number }>(
      unique.map((e) =>
        this.statement(
          `INSERT INTO event(run_id,event_id,sequence,envelope)
       SELECT ?, ?, coalesce(max(sequence),0)+1, ? FROM event WHERE run_id=?
       ON CONFLICT(run_id,event_id) DO NOTHING RETURNING envelope,sequence`,
          runId,
          e.eventId,
          JSON.stringify(e),
          runId,
        ),
      ),
    );
    const stored = results
      .flatMap((r) => r.results)
      .map((row) =>
        EventEnvelope.parse({
          ...JSON.parse(row.envelope),
          sequence: row.sequence,
        }),
      );
    const inserted = new Set(stored.map((e) => e.eventId));
    return {
      stored,
      duplicates: events
        .map((e) => e.eventId)
        .filter((id, i, all) => !inserted.has(id) || all.indexOf(id) !== i),
    };
  }

  async listEvents(runId: string, afterSequence: number, limit: number) {
    const rows = await this.rows<{ envelope: string; sequence: number }>(
      "SELECT envelope,sequence FROM event WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      runId,
      afterSequence,
      limit,
    );
    return rows.map((row) =>
      EventEnvelope.parse({
        ...JSON.parse(row.envelope),
        sequence: row.sequence,
      }),
    );
  }

  async listTasks(runId: string) {
    const rows = await this.rows<{ data: string }>(
      "SELECT data FROM task WHERE run_id=? ORDER BY task_id",
      runId,
    );
    return rows.map((row) => RunTask.parse(JSON.parse(row.data)));
  }

  async recordSteering(record: Steering) {
    await this.rows(
      "INSERT INTO steering(id,run_id,data) VALUES (?,?,?)",
      record.id,
      record.runId,
      JSON.stringify(record),
    );
  }

  async recordApproval(record: Approval) {
    await this.rows(
      "INSERT INTO approval(id,run_id,data) VALUES (?,?,?)",
      record.id,
      record.runId,
      JSON.stringify(record),
    );
  }

  async writeMemory(entry: MemoryEntry) {
    await this.rows(
      "INSERT INTO memory(id,run_id,kind,created_at,data) VALUES (?,?,?,?,?)",
      entry.id,
      entry.runId,
      entry.kind,
      entry.createdAt,
      JSON.stringify(entry),
    );
  }

  async readMemory(runId: string, kind?: MemoryKind) {
    const rows = await this.rows<{ data: string }>(
      "SELECT data FROM memory WHERE run_id=? AND (? IS NULL OR kind=?) ORDER BY created_at,id",
      runId,
      kind ?? null,
      kind ?? null,
    );
    return rows.map((row) => MemoryEntry.parse(JSON.parse(row.data)));
  }
}
