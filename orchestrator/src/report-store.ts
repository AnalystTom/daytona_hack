import { ReportDissection } from "../../src/shared/report";
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

export async function saveReport(env: Env, snapshot: Snapshot, target: string) {
  const { report } = snapshot;
  // JSON literals preserve strings that SurrealDB's RPC variables coerce into record IDs.
  await store(env).query(
    `BEGIN TRANSACTION;
    UPSERT type::record('report_run', $id) CONTENT {
      runId: $id, target: $target,
      completedAt: $completedAt, snapshot: $snapshot
    };
    FOR $figure IN ${JSON.stringify(report.figures)} {
      UPSERT type::record('report_figure', [$id, $figure.id]) CONTENT {
        run: type::record('report_run', $id), source: type::record('report_source', [$id, $figure.sourceId]), original: $figure
      };
    };
    FOR $source IN ${JSON.stringify(report.sources)} {
      UPSERT type::record('report_source', [$id, $source.id]) CONTENT {
        run: type::record('report_run', $id), original: $source
      };
    };
    COMMIT TRANSACTION;`,
    {
      id: report.runId,
      target,
      completedAt: report.completedAt,
      snapshot: JSON.stringify(snapshot),
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

export async function saveEdit(
  env: Env,
  runId: string,
  figureId: string,
  edit: { label: string; value: string },
) {
  await store(env).query(
    `UPSERT type::record('report_edit', [$runId, $figureId]) CONTENT {
    run: type::record('report_run', $runId), figure: type::record('report_figure', [$runId, $figureId]),
    label: ${JSON.stringify(edit.label)}, value: ${JSON.stringify(edit.value)}, updatedAt: time::now()
  }`,
    { runId, figureId },
  );
}
