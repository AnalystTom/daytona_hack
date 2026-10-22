import type { Owners, RunOwner } from "./owners";

// The D1 owner store's behaviour, in memory.
export function memoryOwners(): Owners {
  const runs: (RunOwner & {
    active: boolean;
    revision: number;
    busy: boolean;
  })[] = [];
  const counts = new Map<string, number>();
  return {
    async get(runId) {
      const run = runs.find((r) => r.runId === runId);
      return run ? { ...run } : null;
    },
    async list(owner, since) {
      return runs
        .filter((r) => r.owner === owner && r.createdAt > since)
        .map((r) => ({ ...r }))
        .reverse();
    },
    async finish(runId, owner) {
      const run = runs.find((r) => r.runId === runId && r.owner === owner);
      if (run) run.busy = false;
    },
    async reserve(run, maxActive, perDay, ended, shared) {
      for (const r of runs) {
        if (
          r.owner === run.owner &&
          !r.busy &&
          ended.some(
            (old) =>
              old.runId === r.runId && (old.revision ?? 0) === r.revision,
          )
        )
          r.active = false;
      }
      const existing = runs.find((r) => r.runId === run.runId);
      if (existing && existing.owner !== run.owner)
        throw new Error("Run owner mismatch");
      const active = runs.filter(
        (r) => r.owner === run.owner && r.active && r.runId !== run.runId,
      );
      if (active.length >= maxActive || existing?.busy)
        return "active_run_limit";
      if (existing) {
        existing.active = true;
        existing.busy = true;
        existing.revision++;
      } else {
        const key = `${run.owner} ${new Date(run.createdAt).toISOString().slice(0, 10)}`;
        const day = new Date(run.createdAt).toISOString().slice(0, 10);
        const ipKey = `${shared?.ip} ${day}`;
        if ((counts.get(key) ?? 0) >= perDay) return "daily_run_limit";
        if (shared && (counts.get(ipKey) ?? 0) >= shared.perIp)
          return "ip_daily_limit";
        if (shared && (counts.get(day) ?? 0) >= shared.perAll)
          return "global_daily_limit";
        counts.set(key, (counts.get(key) ?? 0) + 1);
        counts.set(ipKey, (counts.get(ipKey) ?? 0) + 1);
        counts.set(day, (counts.get(day) ?? 0) + 1);
        runs.push({ ...run, active: true, revision: 0, busy: false });
      }
      return undefined;
    },
  };
}
