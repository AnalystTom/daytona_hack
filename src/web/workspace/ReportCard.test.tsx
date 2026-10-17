import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, expect, it } from "vitest";
import { ReportDissection } from "../../shared/report";
import {
  reportContractExample,
  uncertainQuantityExamples,
  incompleteQuantityExamples,
  repeatedQuantityExamples,
} from "../../shared/report.test-data";
import { runView } from "./orchestrator";
import { ReportCard } from "./ReportCard";

describe("report canvas data", () => {
  it.each([
    ...uncertainQuantityExamples,
    ...incompleteQuantityExamples.map(({ quote }) => ({
      quote,
      value: "USD 35 billion",
      unit: "USD billion",
    })),
    ...repeatedQuantityExamples,
  ])(
    "rechecks legacy matches and retains both uncertain quotes: $quote",
    ({ quote, value, unit }) => {
      const report = ReportDissection.parse({
        ...reportContractExample,
        figures: [
          {
            ...reportContractExample.figures[0],
            quote,
            value,
            unit,
          },
        ],
        sources: [
          { ...reportContractExample.sources[0], quote },
          {
            ...reportContractExample.sources[0],
            id: "independent",
            status: "traced_online",
            quote,
            url: "https://independent.example/research",
            quoteUrl: "https://independent.example/research",
          },
        ],
        traces: [
          {
            figureId: "f1",
            sourceId: "independent",
            status: "matches",
            value,
            quote,
            completePassage: true,
            reason: "Legacy comparison",
          },
        ],
      });
      const html = renderToStaticMarkup(
        <ReportCard report={report} evidence={[]} />,
      );
      expect(html).toContain("Unverified online");
      expect(html).not.toContain("Exact source quote match");
      expect(
        html.split(renderToStaticMarkup(<>{quote}</>)).length - 1,
      ).toBeGreaterThanOrEqual(2);
    },
  );
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
  it("renders edited values without changing captured originals", () => {
    const report = ReportDissection.parse({
      ...reportContractExample,
      edits: { f1: { label: "User label", value: "" } },
    });
    const html = renderToStaticMarkup(
      <ReportCard report={report} evidence={[]} />,
    );
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
      "Unverified online",
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
    [
      "matches",
      "$581 billion",
      "including $581 billion in the US",
      "Unverified online",
      false,
    ],
  ])(
    "renders bounded evidence and both quotes for saved %s comparisons",
    (status, value, quote, label, completePassage = true) => {
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
            completePassage,
            reason: "Captured source quotation",
          },
        ],
      });
      const html = renderToStaticMarkup(
        <ReportCard report={report} evidence={[]} />,
      );
      expect(html).toContain(label);
      const figure = report.figures[0];
      assert(figure);
      expect(html).toContain(figure.quote);
      expect(html).toContain(quote);
    },
  );
  it.each(["$", "£", "€", ""])(
    "rechecks saved currency evidence for %s before displaying a match",
    (currency) => {
      const value = `${currency}35 billion`;
      const quote = `Investment reaches ${value}${currency ? "" : " dollars"}.`;
      const report = ReportDissection.parse({
        ...reportContractExample,
        figures: [
          {
            ...reportContractExample.figures[0],
            value,
            unit: `${currency} billion`.trim(),
            quote,
          },
        ],
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
            status: "matches",
            value,
            quote,
            completePassage: true,
            reason: "Previously saved comparison",
          },
        ],
      });
      const html = renderToStaticMarkup(
        <ReportCard report={report} evidence={[]} />,
      );
      expect(html).toContain(
        currency === "€" ? "Exact source quote match" : "Unverified online",
      );
      expect(html).toContain(quote);
    },
  );
});
