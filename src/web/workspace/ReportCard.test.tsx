import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReportDissection } from "../../shared/report";
import { reportContractExample } from "../../shared/report.test-data";
import { runView } from "./orchestrator";
import { ReportCard } from "./ReportCard";

describe("report canvas data", () => {
  it("renders received figures, honest source availability and persisted record identity", () => {
    const report = ReportDissection.parse(reportContractExample);
    const view = runView(report.runId, [
      { seq: 1, ts: report.completedAt, type: "report", data: report },
    ]);
    expect(view.report).toEqual(report);
    const html = renderToStaticMarkup(
      <ReportCard report={report} evidence={[]} />,
    );
    expect(html).toContain("Report dissection");
    expect(html).toContain("$581 billion");
    expect(html).toContain("In the article");
    expect(html).toContain("report_run");
    expect(html).toContain("Download dissection JSON");
  });
  it("renders edited values and replay identity without relabelling the original as fresh", () => {
    const report = ReportDissection.parse({
      ...reportContractExample,
      edits: { f1: { label: "User label", value: "" } },
      replay: {
        runId: "original-run",
        completedAt: reportContractExample.completedAt,
        reason: "Live step failed",
      },
    });
    const html = renderToStaticMarkup(
      <ReportCard report={report} evidence={[]} />,
    );
    expect(html).toContain("Replay of run original-run");
    expect(html).toContain("Empty edited value");
    expect(html).toContain("User label");
    expect(html).toContain("Edited; original retained");
    expect(report.figures[0]?.value).toBe("$581 billion");
  });
});
