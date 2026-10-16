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
  claim(runId: string, owner: string, createdAt: number): Promise<void>;
  // The owner's runs created after `since` (epoch ms), newest first.
  list(owner: string, since: number): Promise<RunOwner[]>;
  // Adds `by` to the owner's run count for `day` and returns the new count. One record per
  // owner and day, so two concurrent starts conflict instead of both slipping under the limit.
  count(owner: string, day: string, by: 1 | -1): Promise<number>;
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
    async claim(runId, owner, createdAt) {
      await db.query(
        "CREATE type::record('run_owner', $runId) CONTENT { owner: $owner, createdAt: $createdAt } RETURN NONE",
        { runId, owner, createdAt },
      );
    },
    async list(owner, since) {
      const [rows] = await db.query(
        `SELECT ${fields} FROM run_owner WHERE owner = $owner AND createdAt > $since ORDER BY createdAt DESC`,
        { owner, since },
      );
      return (rows as RunOwner[] | null) ?? [];
    },
    async count(owner, day, by) {
      const [runs] = await db.query(
        "UPSERT ONLY type::record('run_quota', [$owner, $day]) SET runs = (runs ?? 0) + $by RETURN VALUE runs",
        { owner, day, by },
      );
      return Number(runs);
    },
  };
}
