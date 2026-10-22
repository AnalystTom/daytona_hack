import { ReportDissection } from "../../src/shared/report";
import { resolveStore } from "../../src/worker/store";
import type { Env, Evidence } from "./types";

type Snapshot = { report: ReportDissection; evidence: Evidence[] };
function store(env: Env) {
  const resolved = resolveStore(env);
  if ("missing" in resolved || !env.BLOBS)
    throw new Error("Report storage is not configured (DB, BLOBS)");
  return { db: resolved.store, blobs: env.BLOBS };
}

export async function saveReport(env: Env, snapshot: Snapshot, target: string) {
  const { db, blobs } = store(env);
  const { report } = snapshot;
  const key = `reports/${report.runId}/${crypto.randomUUID()}`;
  await blobs.put(key, JSON.stringify(snapshot));
  try {
    await db.batch([
      db.statement(
        "INSERT INTO report_run(run_id,target,completed_at,snapshot_key) VALUES (?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET target=excluded.target,completed_at=excluded.completed_at,snapshot_key=excluded.snapshot_key",
        report.runId,
        target,
        report.completedAt,
        key,
      ),
      ...report.figures.map((figure) =>
        db.statement(
          "INSERT INTO report_figure(run_id,id,source_id,original) VALUES (?,?,?,?) ON CONFLICT(run_id,id) DO UPDATE SET source_id=excluded.source_id,original=excluded.original",
          report.runId,
          figure.id,
          figure.sourceId,
          JSON.stringify(figure),
        ),
      ),
      ...report.sources.map((source) =>
        db.statement(
          "INSERT INTO report_source(run_id,id,original) VALUES (?,?,?) ON CONFLICT(run_id,id) DO UPDATE SET original=excluded.original",
          report.runId,
          source.id,
          JSON.stringify(source),
        ),
      ),
    ]);
  } catch (error) {
    await blobs.delete(key);
    throw error;
  }
  const [receipt] = await db.rows<{ snapshot_key: string }>(
    "SELECT snapshot_key FROM report_run WHERE run_id=?",
    report.runId,
  );
  const object = receipt ? await blobs.get(receipt.snapshot_key) : null;
  const saved = object ? (JSON.parse(await object.text()) as Snapshot) : null;
  if (!saved || ReportDissection.parse(saved.report).runId !== report.runId)
    throw new Error("Report persistence could not be confirmed");
}

export async function saveEdit(
  env: Env,
  runId: string,
  figureId: string,
  edit: { label: string; value: string },
) {
  await store(env).db.rows(
    "INSERT INTO report_edit(run_id,figure_id,label,value,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(run_id,figure_id) DO UPDATE SET label=excluded.label,value=excluded.value,updated_at=excluded.updated_at",
    runId,
    figureId,
    edit.label,
    edit.value,
    new Date().toISOString(),
  );
}
