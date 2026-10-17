import { afterEach, expect, it, vi } from "vitest";
import { SurrealRunStore } from "../../src/worker/store/surreal";
import { ReportDissection } from "../../src/shared/report";
import {
  GOLDMAN_URL,
  reportContractExample,
} from "../../src/shared/report.test-data";
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

it("passes the snapshot to storage and accepts the returned receipt", async () => {
  const query = vi
    .spyOn(SurrealRunStore.prototype, "query")
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ snapshot: JSON.stringify(snapshot()) }]);
  await saveReport(env, snapshot(), GOLDMAN_URL);
  expect(query.mock.calls[0]?.[1]).toMatchObject({
    id: "test-run",
    target: GOLDMAN_URL,
    successful: true,
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
  await saveReport(env, current, GOLDMAN_URL);
  expect(query.mock.calls[0]?.[1]).toMatchObject({ successful: false });
});

it("parses a returned replay snapshot and rejects missing storage configuration", async () => {
  const query = vi
    .spyOn(SurrealRunStore.prototype, "query")
    .mockResolvedValueOnce([[{ snapshot: JSON.stringify(snapshot()) }]]);
  expect(await latestReport(env, GOLDMAN_URL)).toEqual(snapshot());
  expect(query.mock.calls[0]?.[1]).toEqual({ target: GOLDMAN_URL });
  await expect(latestReport({} as Env, GOLDMAN_URL)).rejects.toThrow(
    "not configured",
  );
});

it("passes an edit's run and figure identity to storage", async () => {
  const query = vi
    .spyOn(SurrealRunStore.prototype, "query")
    .mockResolvedValue([]);
  await saveEdit(env, "test-run", "f1", { label: "Updated", value: "580" });
  expect(query.mock.calls[0]?.[1]).toEqual({
    runId: "test-run",
    figureId: "f1",
  });
});

it("stores the requested target while retaining resolved provenance", async () => {
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
  await saveReport(env, current, GOLDMAN_URL);
  expect(saved.target).toBe(GOLDMAN_URL);
  expect(JSON.parse(saved.snapshot as string).report.sources[0]).toMatchObject({
    url: resolved,
    quoteUrl: resolved,
  });
});

it("rejects a snapshot receipt for another run", async () => {
  const other = snapshot();
  other.report.runId = "other-run";
  other.report.storage.recordId = "other-run";
  vi.spyOn(SurrealRunStore.prototype, "query")
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ snapshot: JSON.stringify(other) }]);
  await expect(saveReport(env, snapshot(), GOLDMAN_URL)).rejects.toThrow(
    "persistence could not be confirmed",
  );
});
