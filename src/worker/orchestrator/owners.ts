import type { SurrealRunStore } from "../store/surreal";

// Who started each run, kept in SurrealDB next to the run records:
//   run_owner:<runId>             { owner, createdAt (epoch ms) }
//   run_quota:[owner, day]        { runs }: runs the owner started on that UTC day
//   run_quota:["ip:<hash>", day]  { runs }: runs started from one network that day
//   run_quota:["all", day]        { runs }: runs started by everyone that day
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
  "record::id(id) AS runId, owner, createdAt, (revision ?? 0) AS revision, (busy ?? false) AS busy, (active ?? true) AS active";

// Character arrays prevent SurrealDB JSON RPC from coercing UUID-prefixed owner emails.
export function surrealOwners(db: SurrealRunStore): Owners {
  return {
    async get(runId) {
      const [row] = await db.query(
        `SELECT ${fields} FROM ONLY type::record('run_owner', $runId)`,
        { runId },
      );
      return (row as RunOwner | null) ?? null;
    },
    async list(owner, since) {
      const [rows] = await db.query(
        `SELECT ${fields} FROM run_owner WHERE owner = array::join($owner, '') AND createdAt > $since ORDER BY createdAt DESC`,
        { owner: Array.from(owner), since },
      );
      return (rows as RunOwner[] | null) ?? [];
    },
    async finish(runId, owner) {
      await db.query(
        "UPDATE type::record('run_owner', $runId) SET busy = false WHERE owner = array::join($owner, '') RETURN NONE",
        { runId, owner: Array.from(owner) },
      );
    },
    async reserve(run, maxActive, perDay, ended, shared) {
      const {
        ip = "none",
        perIp = Number.MAX_SAFE_INTEGER,
        perAll = Number.MAX_SAFE_INTEGER,
      } = shared ?? {};
      const day = new Date(run.createdAt).toISOString().slice(0, 10);
      for (let attempt = 0; ; attempt++) {
        try {
          const results = await db.query(
            `
BEGIN TRANSACTION;
LET $owner = array::join($owner, '');
UPSERT type::record('run_quota', $owner) SET revision = (revision ?? 0) + 1 RETURN NONE;
FOR $old IN $ended {
UPDATE type::record('run_owner', $old.runId) SET active = false
WHERE owner = $owner AND (revision ?? 0) = ($old.revision ?? 0) AND (busy ?? false) = false RETURN NONE;
};
LET $existing = (SELECT * FROM ONLY type::record('run_owner', $runId));
IF $existing != NONE AND $existing.owner != $owner { THROW 'Run owner mismatch'; };
LET $active = array::len((SELECT VALUE id FROM run_owner WHERE owner = $owner AND (active ?? true) = true AND record::id(id) != $runId));
LET $runs = (SELECT VALUE runs FROM ONLY type::record('run_quota', [$owner, $day])) ?? 0;
LET $ipRuns = (SELECT VALUE runs FROM ONLY type::record('run_quota', [$ipKey, $day])) ?? 0;
LET $allRuns = (SELECT VALUE runs FROM ONLY type::record('run_quota', ['all', $day])) ?? 0;
LET $refusal = IF $active >= $maxActive OR ($existing.busy ?? false) { 'active_run_limit' } ELSE IF $existing = NONE AND $runs >= $perDay { 'daily_run_limit' } ELSE IF $existing = NONE AND $ipRuns >= $perIp { 'ip_daily_limit' } ELSE IF $existing = NONE AND $allRuns >= $perAll { 'global_daily_limit' } ELSE { NONE };
IF $refusal = NONE {
IF $existing = NONE {
UPSERT type::record('run_quota', [$owner, $day]) SET runs = $runs + 1 RETURN NONE;
UPSERT type::record('run_quota', [$ipKey, $day]) SET runs = $ipRuns + 1 RETURN NONE;
UPSERT type::record('run_quota', ['all', $day]) SET runs = $allRuns + 1 RETURN NONE;
CREATE type::record('run_owner', $runId) CONTENT { owner: $owner, createdAt: $createdAt, active: true, revision: 0, busy: false } RETURN NONE;
} ELSE {
UPDATE type::record('run_owner', $runId) SET active = true, busy = true, revision = (revision ?? 0) + 1 RETURN NONE;
};
};
RETURN $refusal;
COMMIT TRANSACTION;`,
            {
              ...run,
              owner: Array.from(run.owner),
              day,
              ipKey: `ip:${ip}`,
              perIp,
              perAll,
              maxActive,
              perDay,
              ended: ended.map(({ runId, revision }) => ({ runId, revision })),
            },
          );
          return (results.at(-2) ?? undefined) as Refusal | undefined;
        } catch (error) {
          const message = String(error);
          if (!message.includes("conflict") || attempt === 7) throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.random() * 20 * (attempt + 1)),
          );
        }
      }
    },
  };
}
