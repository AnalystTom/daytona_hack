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
});
