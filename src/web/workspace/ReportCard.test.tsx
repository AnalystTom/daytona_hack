import { DomUtils, parseDocument } from "htmlparser2";
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
  it("renders the dashboard: summary, grouped breakdown, periods and every place a figure appears", () => {
    const [base] = reportContractExample.figures;
    const location = {
      kind: "html",
      start: 1,
      end: 9,
      path: "HTML characters 1–9",
    };
    const chartLocation = { ...location, kind: "chart_data" };
    const cell = (id: string, row: string, column: string, value: string) => ({
      ...base,
      id,
      value,
      unit: "$ billions",
      label: `${row}: ${column}`,
      sourceId: "chart1",
      location: chartLocation,
      group: "investment_breakdown",
      breakdown: { row, column },
    });
    const report = ReportDissection.parse({
      ...reportContractExample,
      figures: [
        {
          ...base,
          label: "Global AI investment, 2026",
          period: "2026",
          mentions: [{ quote: "Restated in the body", location }],
        },
        cell("c1", "US", "US public", "530"),
        cell("c2", "US", "US private", "35"),
        cell("c3", "Global ex-US", "US public", "234"),
        {
          ...cell("c4", "US", "US public", "777"),
          sourceId: "chart2",
          unit: "EUR millions",
        },
        {
          ...base,
          id: "n1",
          value: "",
          label: "Unreadable quantity: 1e3",
          status: "not_observed",
          group: "not_observed",
        },
      ],
      sources: [
        ...reportContractExample.sources,
        {
          ...reportContractExample.sources[0],
          id: "chart1",
          title: "Embedded investment chart",
          url: "https://charts.example/flourish",
          quoteUrl: "https://charts.example/flourish",
        },
        {
          ...reportContractExample.sources[0],
          id: "chart2",
          title: "Second chart",
          url: "https://charts.example/second",
          quoteUrl: "https://charts.example/second",
        },
      ],
      edits: { c1: { label: "My revised investment estimate", value: "999" } },
    });
    const html = renderToStaticMarkup(
      <ReportCard report={report} evidence={[]} />,
    );
    expect(html).toContain("Global AI investment, 2026");
    expect(html).toContain("Period 2026");
    expect(html).toContain("2 places");
    expect(html).toContain("Where invested");
    expect(html).toContain("US private");
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Global ex-US<\/th>/);
    expect(html).toContain("Not observed");
    expect(html).toContain("3 figures read from this source");
    expect(html).toContain("Open chart source");
    const tables = DomUtils.findAll(
      (node) =>
        node.name === "table" &&
        (node.attribs.class ?? "").includes("report-breakdown"),
      parseDocument(html).children,
    );
    expect(tables).toHaveLength(2);
    const first = DomUtils.textContent(tables[0]!);
    const second = DomUtils.textContent(tables[1]!);
    expect(first).toContain("999");
    expect(first).toContain("My revised investment estimate");
    expect(first).toContain("Edited; original retained");
    expect(first).toContain("$ billions");
    expect(first).not.toContain("777");
    expect(first).not.toContain("kept as published");
    expect(first).toContain("User edits are marked");
    expect(second).toContain("777");
    expect(second).toContain("EUR millions");
    expect(second).not.toContain("999");
    const link = (table: (typeof tables)[number]) =>
      DomUtils.findOne((node) => node.name === "a", table.children)?.attribs
        .href;
    expect(link(tables[0]!)).toBe("https://charts.example/flourish");
    expect(link(tables[1]!)).toBe("https://charts.example/second");
  });
});
