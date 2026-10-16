import { EventEnvelope } from "../../shared/contracts";
import { MemoryEntry, type MemoryKind, Run, RunTask } from "../../shared/runs";
import {
  type AppendResult,
  type Approval,
  type RunStore,
  type Steering,
  StoreError,
} from "./types";

export interface SurrealConfig {
  url: string;
  namespace: string;
  database: string;
  user: string;
  password: string;
}

// Records are linked through `run` (and `event`) record links:
//   run:<runId>                       the run, plus lastSequence for ordering
//   event:[runId, eventId]            one event; the composite ID makes duplicates impossible
//   task:[runId, taskId]              latest state of a task, linked to the event that set it
//   steering:<id>, approval:<id>      linked to the run and to the event that announced them
//   memory:<id>                       Agent Memory entry with its sources
//   evidence:<id>, evidence_chunk:<id>_<n>, sign_in:<runId>   evidence capture (src/worker/evidence)
//   example:<key>                     the public example run's snapshot and media (src/worker/example)
// The JSON RPC turns datetime-like strings into datetimes (normalising their format), so an
// event's envelope is kept as JSON text to replay exactly what the producer sent.
const schema = `
DEFINE TABLE IF NOT EXISTS run SCHEMALESS;
DEFINE TABLE IF NOT EXISTS event SCHEMALESS;
DEFINE TABLE IF NOT EXISTS task SCHEMALESS;
DEFINE TABLE IF NOT EXISTS steering SCHEMALESS;
DEFINE TABLE IF NOT EXISTS approval SCHEMALESS;
DEFINE TABLE IF NOT EXISTS memory SCHEMALESS;
DEFINE TABLE IF NOT EXISTS evidence SCHEMALESS;
DEFINE TABLE IF NOT EXISTS evidence_chunk SCHEMALESS;
DEFINE TABLE IF NOT EXISTS sign_in SCHEMALESS;
DEFINE TABLE IF NOT EXISTS example SCHEMALESS;
DEFINE INDEX IF NOT EXISTS event_run_sequence ON event FIELDS run, sequence;
DEFINE INDEX IF NOT EXISTS task_run ON task FIELDS run;
DEFINE INDEX IF NOT EXISTS memory_run ON memory FIELDS run;
`;

const appendSql = `
BEGIN TRANSACTION;
LET $run = type::record('run', $runId);
LET $existing = (SELECT VALUE eventId FROM event WHERE run = $run AND eventId IN $events.eventId);
FOR $e IN $events {
  IF !record::exists(type::record('event', [$runId, $e.eventId])) {
    LET $seq = (UPDATE ONLY $run SET lastSequence += 1 RETURN VALUE lastSequence);
    CREATE type::record('event', [$runId, $e.eventId])
      CONTENT { run: $run, eventId: $e.eventId, sequence: $seq, envelope: $e.envelope };
    IF $e.taskId != NONE {
      UPSERT type::record('task', [$runId, $e.taskId]) CONTENT {
        run: $run, taskId: $e.taskId, state: $e.state, updatedAt: $e.timestamp,
        lastEventId: $e.eventId, event: type::record('event', [$runId, $e.eventId])
      };
    };
  };
};
RETURN $existing;
COMMIT TRANSACTION;
`;

const runFields =
  "record::id(id) AS id, url, goal, status, createdAt, updatedAt, specApprovedAt";

const schemaReady = new Map<string, Promise<void>>();

// SurrealDB 3.x over its HTTP RPC endpoint, so it runs on Workers with plain fetch.
export class SurrealRunStore implements RunStore {
  private readonly endpoint: string;

  constructor(
    private readonly config: SurrealConfig,
    private readonly fetcher: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {
    this.endpoint = `${config.url.replace(/\/+$/, "")}/rpc`;
  }

  private async rpc(sql: string, vars: Record<string, unknown>) {
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "surreal-ns": this.config.namespace,
          "surreal-db": this.config.database,
          authorization: `Basic ${btoa(`${this.config.user}:${this.config.password}`)}`,
        },
        body: JSON.stringify({ id: 1, method: "query", params: [sql, vars] }),
      });
    } catch (error) {
      throw new StoreError(`SurrealDB request failed: ${String(error)}`);
    }
    if (!response.ok) {
      throw new StoreError(`SurrealDB answered HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      result?: { status: string; result: unknown }[];
      error?: { message: string };
    };
    if (body.error) throw new StoreError(`SurrealDB: ${body.error.message}`);
    const results = body.result ?? [];
    const failed = results.find((r) => r.status !== "OK");
    if (failed) throw new StoreError(`SurrealDB: ${String(failed.result)}`);
    return results.map((r) => r.result);
  }

  // Also used by the evidence store, so both share one client and schema.
  async query(sql: string, vars: Record<string, unknown> = {}) {
    const key = `${this.endpoint} ${this.config.namespace} ${this.config.database}`;
    let ready = schemaReady.get(key);
    if (!ready) {
      ready = this.rpc(schema, {}).then(() => undefined);
      schemaReady.set(key, ready);
      ready.catch(() => schemaReady.delete(key));
    }
    await ready;
    return this.rpc(sql, vars);
  }

  async createRun(run: Run) {
    const { id, ...fields } = run;
    await this.query(
      "CREATE type::record('run', $id) CONTENT $fields RETURN NONE",
      { id, fields: { ...fields, lastSequence: 0 } },
    );
  }

  async getRun(runId: string) {
    const [row] = await this.query(
      `SELECT ${runFields} FROM ONLY type::record('run', $runId)`,
      { runId },
    );
    return row ? Run.parse(row) : null;
  }

  async updateRun(runId: string, patch: Partial<Omit<Run, "id">>) {
    await this.query(
      "UPDATE ONLY type::record('run', $runId) MERGE $patch RETURN NONE",
      { runId, patch },
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
    const vars = {
      runId,
      events: unique.map((e) => ({
        eventId: e.eventId,
        taskId: e.taskId,
        state: e.state,
        timestamp: e.timestamp,
        envelope: JSON.stringify(e),
      })),
    };
    // Concurrent appends to one run conflict on its lastSequence; retrying is safe because
    // events already stored are skipped as duplicates.
    let results: unknown[] = [];
    let attempt = 1;
    for (; ; attempt++) {
      try {
        results = await this.query(appendSql, vars);
        break;
      } catch (error) {
        if (!(error instanceof StoreError) || attempt === 8) throw error;
        await new Promise((r) => setTimeout(r, Math.random() * 20 * attempt));
      }
    }
    // Statement results are BEGIN, LET, LET, FOR, RETURN, COMMIT.
    const existing = new Set(results.at(-2) as string[]);
    // A retry that finds the whole batch stored means an earlier attempt committed it.
    if (attempt > 1 && unique.every((e) => existing.has(e.eventId))) {
      existing.clear();
    }
    const ids = unique.map((e) => e.eventId);
    const [stored] = await this.query(
      `SELECT envelope, sequence FROM event
       WHERE run = type::record('run', $runId) AND eventId IN $ids
       ORDER BY sequence`,
      { runId, ids: ids.filter((id) => !existing.has(id)) },
    );
    return {
      stored: toEvents(stored),
      duplicates: events
        .map((e) => e.eventId)
        .filter((id, i, all) => existing.has(id) || all.indexOf(id) !== i),
    };
  }

  async listEvents(runId: string, afterSequence: number, limit: number) {
    const [rows] = await this.query(
      `SELECT envelope, sequence FROM event
       WHERE run = type::record('run', $runId) AND sequence > $after
       ORDER BY sequence LIMIT $limit`,
      { runId, after: afterSequence, limit },
    );
    return toEvents(rows);
  }

  async listTasks(runId: string) {
    const [rows] = await this.query(
      `SELECT taskId, state, updatedAt, lastEventId FROM task
       WHERE run = type::record('run', $runId) ORDER BY taskId`,
      { runId },
    );
    return RunTask.array().parse(rows);
  }

  async recordSteering(steering: Steering) {
    await this.recordLinked("steering", steering);
  }

  async recordApproval(approval: Approval) {
    await this.recordLinked("approval", approval);
  }

  private async recordLinked(table: string, record: Steering | Approval) {
    const { id, ...fields } = record;
    await this.query(
      `CREATE type::record($table, $id) CONTENT object::extend($fields, {
         run: type::record('run', $fields.runId),
         event: type::record('event', [$fields.runId, $fields.eventId])
       }) RETURN NONE`,
      { table, id, fields },
    );
  }

  async writeMemory(entry: MemoryEntry) {
    const { id, ...fields } = entry;
    await this.query(
      `CREATE type::record('memory', $id) CONTENT object::extend($fields, {
         run: type::record('run', $fields.runId)
       }) RETURN NONE`,
      { id, fields },
    );
  }

  async readMemory(runId: string, kind?: MemoryKind) {
    const [rows] = await this.query(
      `SELECT record::id(id) AS id, runId, kind, content, sources, createdAt FROM memory
       WHERE run = type::record('run', $runId) AND ($kind = NONE OR kind = $kind)
       ORDER BY createdAt, id`,
      { runId, kind },
    );
    return MemoryEntry.array().parse(rows);
  }
}

function toEvents(rows: unknown) {
  return (rows as { envelope: string; sequence: number }[]).map((row) =>
    EventEnvelope.parse({
      ...JSON.parse(row.envelope),
      sequence: row.sequence,
    }),
  );
}
