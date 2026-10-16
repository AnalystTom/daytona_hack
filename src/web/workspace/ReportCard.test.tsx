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
  it.each([
    [
      "matches",
      "$581 billion",
      "including $581 billion in the US",
      "Exact source quote match",
    ],
    [
      "matches",
      "$581 bn",
      "including $581 billion in the US",
      "Unverified online",
    ],
    [
      "matches",
      "$581 billion",
      "including $581 billion Canadian dollars in the US",
      "Unverified online",
    ],
    [
      "differs",
      "$582 billion",
      "including $582 billion in the US",
      "Unverified online",
    ],
    ["not_found", "", "including $581 million in the US", "Unverified online"],
  ])(
    "renders bounded evidence and both quotes for saved %s comparisons",
    (status, value, quote, label) => {
      const report = ReportDissection.parse({
        ...reportContractExample,
        sources: [
          ...reportContractExample.sources,
          {
            ...reportContractExample.sources[0],
            id: "independent",
            url: "https://independent.example/research",
            quoteUrl: "https://independent.example/research",
            quote,
            status: "traced_online",
          },
        ],
        traces: [
          {
            figureId: "f1",
            sourceId: "independent",
            status,
            value,
            quote,
            reason: "Captured source quotation",
          },
        ],
      });
      const html = renderToStaticMarkup(
        <ReportCard report={report} evidence={[]} />,
      );
      expect(html).toContain(label);
      expect(html).toContain(report.figures[0].quote);
      expect(html).toContain(quote);
    },
  );
});
