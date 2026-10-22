import { assert, describe, expect, it } from "vitest";
import { ReportDissection } from "../../src/shared/report";
import { reportContractExample } from "../../src/shared/report.test-data";
import { D1RunStore } from "../../src/worker/store/d1";
import { testStorage } from "../../src/worker/test/storage";
import { saveEdit, saveReport } from "./report-store";
import type { Env } from "./types";

const cloudflare = testStorage();
const env = cloudflare as Env;
describe("report persistence in local D1 and R2", () => {
  const db = new D1RunStore(cloudflare.DB, cloudflare.BLOBS);
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
    await saveReport(env, snapshot, report.sources[0].url ?? "");
    const [receipt] = await db.rows<{ snapshot_key: string }>(
      "SELECT snapshot_key FROM report_run WHERE run_id=?",
      report.runId,
    );
    const stored = await cloudflare.BLOBS.get(receipt.snapshot_key);
    expect(await stored?.json()).toEqual(snapshot);
    const figures = await db.rows<{ original: string }>(
      "SELECT original FROM report_figure",
    );
    const originals = figures
      .map((row) => JSON.parse(row.original) as { id: string })
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(originals).toEqual(report.figures);
    const sources = await db.rows<{ original: string }>(
      "SELECT original FROM report_source",
    );
    expect(sources.map((row) => JSON.parse(row.original))).toEqual(
      report.sources,
    );

    const edit = {
      label: "US: US public",
      value: 'US: value " ; DELETE report_run; € 🌍\n',
    };
    await saveEdit(env, report.runId, "f0", edit);
    await saveEdit(env, "other-run", "f0", {
      label: "US: US private",
      value: "",
    });
    expect(
      await db.rows(
        "SELECT label,value FROM report_edit WHERE run_id=?",
        report.runId,
      ),
    ).toEqual([edit]);
    expect(
      await db.rows(
        "SELECT label,value FROM report_edit WHERE run_id=?",
        "other-run",
      ),
    ).toEqual([{ label: "US: US private", value: "" }]);
    const reread = await cloudflare.BLOBS.get(receipt.snapshot_key);
    assert(reread);
    expect(await reread.json()).toEqual(snapshot);
  });

  it("reclaims replaced snapshots while preserving other runs", async () => {
    const report = ReportDissection.parse(reportContractExample);
    await saveReport(env, { report, evidence: [] }, "https://example.com");
    const other = {
      report: {
        ...report,
        runId: "other-run",
        storage: { ...report.storage, recordId: "other-run" },
      },
      evidence: [],
    };
    await saveReport(env, other, "https://other.example.com");
    const [previous] = await db.rows<{ snapshot_key: string }>(
      "SELECT snapshot_key FROM report_run WHERE run_id=?",
      report.runId,
    );
    report.completedAt = "2026-10-22T12:00:00Z";
    const replacement = { report, evidence: [] };
    await saveReport(env, replacement, "https://example.com");
    const references = await db.rows<{ run_id: string; snapshot_key: string }>(
      "SELECT run_id,snapshot_key FROM report_run ORDER BY run_id",
    );
    expect(
      (await cloudflare.BLOBS.list()).objects.map((object) => object.key).sort(),
    ).toEqual(references.map((row) => row.snapshot_key).sort());
    expect(await cloudflare.BLOBS.get(previous.snapshot_key)).toBeNull();
    for (const reference of references) {
      const object = await cloudflare.BLOBS.get(reference.snapshot_key);
      expect(await object?.json()).toEqual(
        reference.run_id === report.runId ? replacement : other,
      );
    }
  });

  it("preserves the previous snapshot when the reference transaction rolls back", async () => {
    const report = ReportDissection.parse(reportContractExample);
    const snapshot = { report, evidence: [] };
    await saveReport(env, snapshot, "https://example.com");
    const [previous] = await db.rows<{ snapshot_key: string }>(
      "SELECT snapshot_key FROM report_run WHERE run_id=?",
      report.runId,
    );
    await db.rows(
      "CREATE TRIGGER reject_report BEFORE INSERT ON report_source BEGIN SELECT RAISE(ABORT, 'rejected report'); END",
    );
    try {
      await expect(
        saveReport(
          env,
          {
            report: { ...report, completedAt: "2026-10-22T12:00:00Z" },
            evidence: [],
          },
          "https://replacement.example.com",
        ),
      ).rejects.toThrow("rejected report");
      expect(
        await db.rows(
          "SELECT snapshot_key FROM report_run WHERE run_id=?",
          report.runId,
        ),
      ).toEqual([previous]);
      expect(
        (await cloudflare.BLOBS.list()).objects.map((object) => object.key),
      ).toEqual([previous.snapshot_key]);
      expect(
        await (await cloudflare.BLOBS.get(previous.snapshot_key))?.json(),
      ).toEqual(snapshot);
    } finally {
      await db.rows("DROP TRIGGER reject_report");
    }
  });

  it("keeps concurrent replacements readable and reclaims every loser", async () => {
    const report = ReportDissection.parse(reportContractExample);
    await saveReport(env, { report, evidence: [] }, "https://example.com");
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const blobs = new Proxy(cloudflare.BLOBS, {
      get(target, property) {
        if (property === "get")
          return async (key: string) => {
            if (++reads === 1) {
              reached();
              await resume;
            }
            return target.get(key);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const first = saveReport(
      { ...env, BLOBS: blobs },
      { report, evidence: [] },
      "https://first.example.com",
    );
    try {
      await paused;
      await saveReport(
        env,
        {
          report: { ...report, completedAt: "2026-10-22T12:00:00Z" },
          evidence: [],
        },
        "https://second.example.com",
      );
    } finally {
      release();
      await first;
    }
    const [reference] = await db.rows<{ snapshot_key: string }>(
      "SELECT snapshot_key FROM report_run WHERE run_id=?",
      report.runId,
    );
    expect(
      (await cloudflare.BLOBS.list()).objects.map((object) => object.key),
    ).toEqual([reference.snapshot_key]);
    expect(
      await (await cloudflare.BLOBS.get(reference.snapshot_key))?.json(),
    ).toMatchObject({ report: { runId: report.runId } });
  });
});
