import type { SurrealRunStore } from "../store/surreal";

// Who started each run, kept in SurrealDB next to the run records:
//   run_owner:<runId>             { owner, createdAt (epoch ms) }
//   run_quota:[owner, day]        { runs }: runs the owner started on that UTC day
export interface RunOwner {
  runId: string;
  owner: string;
  createdAt: number;
}

export interface Owners {
  get(runId: string): Promise<RunOwner | null>;
  list(owner: string, since: number): Promise<RunOwner[]>;
  reserve(
    run: RunOwner,
    maxActive: number,
    perDay: number,
    ended: string[],
  ): Promise<"active_run_limit" | "daily_run_limit" | undefined>;
}

const fields = "record::id(id) AS runId, owner, createdAt";

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
        `SELECT ${fields} FROM run_owner WHERE owner = $owner AND createdAt > $since ORDER BY createdAt DESC`,
        { owner, since },
      );
      return (rows as RunOwner[] | null) ?? [];
    },
    async reserve(run, maxActive, perDay, ended) {
      const day = new Date(run.createdAt).toISOString().slice(0, 10);
      for (let attempt = 0; ; attempt++) {
        try {
          const results = await db.query(
            `
BEGIN TRANSACTION;
UPSERT type::record('run_quota', $owner) SET revision = (revision ?? 0) + 1 RETURN NONE;
UPDATE run_owner SET active = false WHERE owner = $owner AND record::id(id) IN $ended RETURN NONE;
LET $active = array::len((SELECT VALUE id FROM run_owner WHERE owner = $owner AND (active ?? true) = true));
LET $runs = (SELECT VALUE runs FROM ONLY type::record('run_quota', [$owner, $day])) ?? 0;
LET $refusal = IF $active >= $maxActive { 'active_run_limit' } ELSE IF $runs >= $perDay { 'daily_run_limit' } ELSE { NONE };
IF $refusal = NONE {
UPSERT type::record('run_quota', [$owner, $day]) SET runs = $runs + 1 RETURN NONE;
CREATE type::record('run_owner', $runId) CONTENT { owner: $owner, createdAt: $createdAt, active: true } RETURN NONE;
};
RETURN $refusal;
COMMIT TRANSACTION;`,
            { ...run, day, maxActive, perDay, ended },
          );
          return (results.at(-2) ?? undefined) as
            | "active_run_limit"
            | "daily_run_limit"
            | undefined;
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
