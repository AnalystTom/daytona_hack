import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReportDissection } from "../../src/shared/report";
import { reportContractExample } from "../../src/shared/report.test-data";
import { SurrealRunStore } from "../../src/worker/store/surreal";
import { latestReport, saveEdit, saveReport } from "./report-store";
import type { Env } from "./types";

// Like the run-store contract tests, use an explicitly supplied disposable server.
const testEnv =
  (globalThis as { process?: { env: Record<string, string | undefined> } })
    .process?.env ?? {};
const config = {
  url: testEnv.SURREALDB_TEST_URL ?? "",
  namespace: `report_test_${Date.now()}`,
  database: "reports",
  user: testEnv.SURREALDB_TEST_USER ?? "root",
  password: testEnv.SURREALDB_TEST_PASSWORD ?? "root",
};
const env = {
  SURREALDB_URL: config.url,
  SURREALDB_NAMESPACE: config.namespace,
  SURREALDB_DATABASE: config.database,
  SURREALDB_USER: config.user,
  SURREALDB_PASSWORD: config.password,
} as Env;

describe.skipIf(!config.url)("report persistence in real SurrealDB", () => {
  const db = new SurrealRunStore(config);
  const admin = async (sql: string) => {
    const response = await fetch(`${config.url}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${btoa(`${config.user}:${config.password}`)}`,
      },
      body: JSON.stringify({ id: 1, method: "query", params: [sql, {}] }),
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as {
      error?: unknown;
      result: { status: string }[];
    };
    expect(body.error).toBeUndefined();
    expect(body.result.every((result) => result.status === "OK")).toBe(true);
  };
  beforeAll(async () => {
    await admin(
      `DEFINE NAMESPACE ${config.namespace}; USE NS ${config.namespace}; DEFINE DATABASE ${config.database};`,
    );
  });
  afterAll(async () => {
    await admin(`REMOVE NAMESPACE ${config.namespace}`);
  });

  it("preserves exact originals and isolated edits, including record-like strings and quoted SQL", async () => {
    const report = ReportDissection.parse(reportContractExample);
    report.traces = [];
    report.figures = [
      "US: US public",
      "US: US private",
      "US: Non-US public",
    ].map((label, i) => ({ ...report.figures[0], id: `f${i}`, label }));
    report.sources[0].title = 'US: source "quoted"; RETURN "data"; € 🌍';
    const snapshot = { report, evidence: [] };
    await saveReport(env, snapshot, true);
    expect(await latestReport(env)).toEqual(snapshot);
    const [figures] = await db.query("SELECT original FROM report_figure");
    const originals = (figures as { original: { id: string } }[])
      .map((row) => row.original)
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(originals).toEqual(report.figures);
    const [sources] = await db.query("SELECT original FROM report_source");
    expect(
      (sources as { original: unknown }[]).map((row) => row.original),
    ).toEqual(report.sources);

    const edit = {
      label: "US: US public",
      value: 'US: value " ; DELETE report_run; € 🌍\n',
    };
    await saveEdit(env, report.runId, "f0", edit);
    await saveEdit(env, "other-run", "f0", {
      label: "US: US private",
      value: "",
    });
    const [edits] = await db.query(
      "SELECT label, value FROM report_edit WHERE run = type::record('report_run', $id)",
      { id: report.runId },
    );
    expect(edits).toEqual([edit]);
    const [other] = await db.query(
      "SELECT label, value FROM report_edit WHERE run = type::record('report_run', 'other-run')",
    );
    expect(other).toEqual([{ label: "US: US private", value: "" }]);
    expect(await latestReport(env)).toEqual(snapshot);
  });
});
