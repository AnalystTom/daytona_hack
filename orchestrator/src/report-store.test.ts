import { afterEach, expect, it, vi } from "vitest";
import { SurrealRunStore } from "../../src/worker/store/surreal";
import { GOLDMAN_URL, ReportDissection } from "../../src/shared/report";
import { reportContractExample } from "../../src/shared/report.test-data";
import { latestReport, saveEdit, saveReport } from "./report-store";
import type { Env } from "./types";

afterEach(() => vi.restoreAllMocks());
const env = {
  SURREALDB_URL: "https://db.test",
  SURREALDB_NAMESPACE: "test",
  SURREALDB_DATABASE: "test",
  SURREALDB_USER: "test",
  SURREALDB_PASSWORD: "test",
} as Env;
const snapshot = () => ({
  report: ReportDissection.parse(reportContractExample),
  evidence: [],
});

it("writes linked figure/source originals atomically and confirms the persisted snapshot", async () => {
  const query = vi
    .spyOn(SurrealRunStore.prototype, "query")
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ snapshot: JSON.stringify(snapshot()) }]);
  await saveReport(env, snapshot(), true);
  expect(query.mock.calls[0]?.[0]).toContain("BEGIN TRANSACTION");
  expect(query.mock.calls[0]?.[0]).toContain("report_figure");
  expect(query.mock.calls[0]?.[0]).toContain("report_source");
  expect(query.mock.calls[0]?.[1]).toMatchObject({
    id: "test-run",
    demo: true,
    successful: true,
  });
  expect(query.mock.calls[1]?.[0]).toContain("SELECT snapshot");
});

it("never promotes a replay to the successful demo fallback", async () => {
  const current = snapshot();
  current.report.replay = {
    runId: "prior",
    completedAt: current.report.completedAt,
    reason: "Live failure",
  };
  const query = vi
    .spyOn(SurrealRunStore.prototype, "query")
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ snapshot: JSON.stringify(current) }]);
  await saveReport(env, current, true);
  expect(query.mock.calls[0]?.[1]).toMatchObject({ successful: false });
});

it("returns only the most recent real successful demo and rejects missing storage", async () => {
  const query = vi
    .spyOn(SurrealRunStore.prototype, "query")
    .mockResolvedValueOnce([[{ snapshot: JSON.stringify(snapshot()) }]]);
  expect(await latestReport(env)).toEqual(snapshot());
  expect(query.mock.calls[0]?.[0]).toContain("successful = true");
  expect(query.mock.calls[0]?.[0]).toContain(
    "ORDER BY completedAt DESC LIMIT 1",
  );
  await expect(latestReport({} as Env)).rejects.toThrow("not configured");
});

it("stores user edits separately from immutable captured originals", async () => {
  const query = vi
    .spyOn(SurrealRunStore.prototype, "query")
    .mockResolvedValue([]);
  await saveEdit(env, "test-run", "f1", { label: "Updated", value: "580" });
  expect(query.mock.calls[0]?.[0]).toContain("report_edit");
  expect(query.mock.calls[0]?.[0]).not.toContain(
    "UPDATE type::record('report_figure'",
  );
});

it.each([true, false])(
  "keeps resolved provenance separate from replay identity for demo=%s",
  async (demo) => {
    const current = snapshot();
    const resolved = `${GOLDMAN_URL}/`;
    current.report.sources[0].url = resolved;
    current.report.sources[0].quoteUrl = resolved;
    let saved: Record<string, unknown> = {};
    vi.spyOn(SurrealRunStore.prototype, "query")
      .mockImplementationOnce(async (_sql, vars) => {
        saved = vars ?? {};
        return [];
      })
      .mockImplementationOnce(async () => [{ snapshot: saved.snapshot }])
      .mockImplementationOnce(async (_sql, vars) => [
        saved.demo && saved.successful && saved.target === vars?.target
          ? [{ snapshot: saved.snapshot }]
          : [],
      ]);
    await saveReport(env, current, demo);
    expect(saved.target).toBe(demo ? GOLDMAN_URL : resolved);
    expect(
      JSON.parse(saved.snapshot as string).report.sources[0],
    ).toMatchObject({ url: resolved, quoteUrl: resolved });
    expect(await latestReport(env)).toEqual(demo ? current : undefined);
  },
);
