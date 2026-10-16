import { GOLDMAN_URL, ReportDissection } from "../../src/shared/report";
import { SurrealRunStore } from "../../src/worker/store/surreal";
import type { Env, Evidence } from "./types";

type Snapshot = { report: ReportDissection; evidence: Evidence[] };

// Use the existing HTTP RPC implementation, credentials and error checks.
function store(env: Env) {
  const {
    SURREALDB_URL: url,
    SURREALDB_NAMESPACE: namespace,
    SURREALDB_DATABASE: database,
    SURREALDB_USER: user,
    SURREALDB_PASSWORD: password,
  } = env;
  if (!url || !namespace || !database || !user || !password)
    throw new Error("Report storage is not configured (SurrealDB)");
  return new SurrealRunStore({ url, namespace, database, user, password });
}

export async function saveReport(env: Env, snapshot: Snapshot, demo: boolean) {
  const { report } = snapshot;
  await store(env).query(
    `BEGIN TRANSACTION;
    UPSERT type::record('report_run', $id) CONTENT {
      runId: $id, target: $target, demo: $demo, successful: $successful,
      completedAt: $completedAt, snapshot: $snapshot
    };
    FOR $figure IN $figures {
      UPSERT type::record('report_figure', [$id, $figure.id]) CONTENT {
        run: type::record('report_run', $id), source: type::record('report_source', [$id, $figure.sourceId]), original: $figure
      };
    };
    FOR $source IN $sources {
      UPSERT type::record('report_source', [$id, $source.id]) CONTENT {
        run: type::record('report_run', $id), original: $source
      };
    };
    COMMIT TRANSACTION;`,
    {
      id: report.runId,
      target:
        report.sources.find((source) => source.id === "article")?.url ?? "",
      demo,
      successful: !report.replay,
      completedAt: report.completedAt,
      snapshot: JSON.stringify(snapshot),
      figures: report.figures,
      sources: report.sources,
    },
  );
  // A successful write receipt includes a reread, not just an HTTP response.
  const [rows] = await store(env).query(
    "SELECT snapshot FROM ONLY type::record('report_run', $id)",
    { id: report.runId },
  );
  const row = rows as { snapshot?: string };
  if (
    !row?.snapshot ||
    ReportDissection.parse((JSON.parse(row.snapshot) as Snapshot).report)
      .runId !== report.runId
  )
    throw new Error("Report persistence could not be confirmed");
}

export async function latestReport(env: Env): Promise<Snapshot | undefined> {
  const [rows] = await store(env).query(
    `SELECT snapshot, completedAt FROM report_run WHERE demo = true AND successful = true AND target = $target ORDER BY completedAt DESC LIMIT 1`,
    { target: GOLDMAN_URL },
  );
  const row = (rows as { snapshot: string }[])[0];
  if (!row) return undefined;
  const snapshot: Snapshot = JSON.parse(row.snapshot);
  return {
    report: ReportDissection.parse(snapshot.report),
    evidence: snapshot.evidence,
  };
}

export async function saveEdit(
  env: Env,
  runId: string,
  figureId: string,
  edit: { label: string; value: string },
) {
  await store(env).query(
    `UPSERT type::record('report_edit', [$runId, $figureId]) CONTENT {
    run: type::record('report_run', $runId), figure: type::record('report_figure', [$runId, $figureId]),
    label: $label, value: $value, updatedAt: time::now()
  }`,
    { runId, figureId, ...edit },
  );
}
