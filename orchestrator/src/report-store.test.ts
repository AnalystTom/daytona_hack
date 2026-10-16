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

it("passes captured originals to storage and accepts the returned snapshot receipt", async () => {
  const query = vi
    .spyOn(SurrealRunStore.prototype, "query")
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ snapshot: JSON.stringify(snapshot()) }]);
  await saveReport(env, snapshot(), true);
  expect(query.mock.calls[0]?.[1]).toMatchObject({
    id: "test-run",
    demo: true,
    successful: true,
    figures: snapshot().report.figures,
    sources: snapshot().report.sources,
    snapshot: JSON.stringify(snapshot()),
  });
  expect(query.mock.calls[1]?.[1]).toEqual({ id: "test-run" });
});

it("marks replay snapshots as unsuccessful in storage inputs", async () => {
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

it("parses a returned replay snapshot and rejects missing storage configuration", async () => {
  const query = vi
    .spyOn(SurrealRunStore.prototype, "query")
    .mockResolvedValueOnce([[{ snapshot: JSON.stringify(snapshot()) }]]);
  expect(await latestReport(env)).toEqual(snapshot());
  expect(query.mock.calls[0]?.[1]).toEqual({ target: GOLDMAN_URL });
  await expect(latestReport({} as Env)).rejects.toThrow("not configured");
});

it("passes an edit and its run and figure identity to storage", async () => {
  const query = vi
    .spyOn(SurrealRunStore.prototype, "query")
    .mockResolvedValue([]);
  await saveEdit(env, "test-run", "f1", { label: "Updated", value: "580" });
  expect(query.mock.calls[0]?.[1]).toEqual({
    runId: "test-run",
    figureId: "f1",
    label: "Updated",
    value: "580",
  });
});

it.each([true, false])(
  "passes stable demo identity to storage while retaining resolved provenance: demo=%s",
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
      .mockImplementationOnce(async () => [{ snapshot: saved.snapshot }]);
    await saveReport(env, current, demo);
    expect(saved.target).toBe(demo ? GOLDMAN_URL : resolved);
    expect(
      JSON.parse(saved.snapshot as string).report.sources[0],
    ).toMatchObject({ url: resolved, quoteUrl: resolved });
  },
);

it("rejects a snapshot receipt for another run", async () => {
  const other = snapshot();
  other.report.runId = "other-run";
  other.report.storage.recordId = "other-run";
  vi.spyOn(SurrealRunStore.prototype, "query")
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ snapshot: JSON.stringify(other) }]);
  await expect(saveReport(env, snapshot(), true)).rejects.toThrow(
    "persistence could not be confirmed",
  );
});
