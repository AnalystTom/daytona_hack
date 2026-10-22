import type { D1RunStore } from "../store/d1";

export interface RunOwner {
  runId: string;
  owner: string;
  createdAt: number;
  revision?: number;
  busy?: boolean;
  active?: boolean;
}

export type Refusal =
  | "active_run_limit"
  | "daily_run_limit"
  | "ip_daily_limit"
  | "global_daily_limit";

// Limits shared across owners; a run that already exists is never charged again.
export interface SharedLimits {
  ip: string;
  perIp: number;
  perAll: number;
}

export interface Owners {
  get(runId: string): Promise<RunOwner | null>;
  list(owner: string, since: number): Promise<RunOwner[]>;
  reserve(
    run: RunOwner,
    maxActive: number,
    perDay: number,
    ended: RunOwner[],
    shared?: SharedLimits,
  ): Promise<Refusal | undefined>;
  finish(runId: string, owner: string): Promise<void>;
}

const fields =
  "run_id AS runId, owner, created_at AS createdAt, revision, busy, active";
const ownerRow = (row: RunOwner): RunOwner => ({
  ...row,
  busy: Boolean(row.busy),
  active: Boolean(row.active),
});

export function d1Owners(db: D1RunStore): Owners {
  return {
    async get(runId) {
      const [row] = await db.rows<RunOwner>(
        `SELECT ${fields} FROM run_owner WHERE run_id=?`,
        runId,
      );
      return row ? ownerRow(row) : null;
    },
    async list(owner, since) {
      return (
        await db.rows<RunOwner>(
          `SELECT ${fields} FROM run_owner WHERE owner=? AND created_at>? ORDER BY created_at DESC`,
          owner,
          since,
        )
      ).map(ownerRow);
    },
    async finish(runId, owner) {
      await db.rows(
        "UPDATE run_owner SET busy=0 WHERE run_id=? AND owner=?",
        runId,
        owner,
      );
    },
    async reserve(run, maxActive, perDay, ended, shared) {
      const day = new Date(run.createdAt).toISOString().slice(0, 10);
      const id = crypto.randomUUID();
      const scopes = [
        `owner:${run.owner}`,
        `ip:${shared?.ip ?? "none"}`,
        "all",
      ];
      const statements = ended.map((old) =>
        db.statement(
          "UPDATE run_owner SET active=0 WHERE run_id=? AND owner=? AND revision=? AND busy=0",
          old.runId,
          run.owner,
          old.revision ?? 0,
        ),
      );
      statements.push(
        db.statement(
          `INSERT INTO admission(id,refusal) SELECT ?, CASE
        WHEN EXISTS(SELECT 1 FROM run_owner WHERE run_id=? AND owner<>?) THEN 'owner_mismatch'
        WHEN (SELECT count(*) FROM run_owner WHERE owner=? AND active=1 AND run_id<>?)>=?
          OR EXISTS(SELECT 1 FROM run_owner WHERE run_id=? AND busy=1) THEN 'active_run_limit'
        WHEN NOT EXISTS(SELECT 1 FROM run_owner WHERE run_id=?) THEN CASE
          WHEN coalesce((SELECT runs FROM run_quota WHERE scope=? AND day=?),0)>=? THEN 'daily_run_limit'
          WHEN coalesce((SELECT runs FROM run_quota WHERE scope=? AND day=?),0)>=? THEN 'ip_daily_limit'
          WHEN coalesce((SELECT runs FROM run_quota WHERE scope=? AND day=?),0)>=? THEN 'global_daily_limit'
          ELSE NULL END
        ELSE NULL END`,
          id,
          run.runId,
          run.owner,
          run.owner,
          run.runId,
          maxActive,
          run.runId,
          run.runId,
          scopes[0],
          day,
          perDay,
          scopes[1],
          day,
          shared?.perIp ?? Number.MAX_SAFE_INTEGER,
          scopes[2],
          day,
          shared?.perAll ?? Number.MAX_SAFE_INTEGER,
        ),
      );
      for (const scope of scopes)
        statements.push(
          db.statement(
            `INSERT INTO run_quota(scope,day,runs)
        SELECT ?,?,1 WHERE (SELECT refusal FROM admission WHERE id=?) IS NULL
          AND NOT EXISTS(SELECT 1 FROM run_owner WHERE run_id=?)
        ON CONFLICT(scope,day) DO UPDATE SET runs=runs+1`,
            scope,
            day,
            id,
            run.runId,
          ),
        );
      statements.push(
        db.statement(
          `INSERT INTO run_owner(run_id,owner,created_at)
        SELECT ?,?,? WHERE (SELECT refusal FROM admission WHERE id=?) IS NULL
        ON CONFLICT(run_id) DO UPDATE SET active=1,busy=1,revision=revision+1`,
          run.runId,
          run.owner,
          run.createdAt,
          id,
        ),
      );
      const resultIndex = statements.length;
      statements.push(
        db.statement("SELECT refusal FROM admission WHERE id=?", id),
        db.statement("DELETE FROM admission WHERE id=?", id),
      );
      const result = await db.batch<{
        refusal: Refusal | "owner_mismatch" | null;
      }>(statements);
      const refusal = result[resultIndex]?.results[0]?.refusal;
      if (refusal === "owner_mismatch") throw new Error("Run owner mismatch");
      return refusal ?? undefined;
    },
  };
}
