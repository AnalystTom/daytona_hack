import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanText,
  dissect,
  extractChart,
  extractFigures,
  sourceFetch,
} from "./dissection";
import captured from "./fixtures/goldman-report";
import { llmJson, sha256 } from "./services";
import type { Env } from "./types";
import {
  uncertainQuantityExamples,
  incompleteQuantityExamples,
  repeatedQuantityExamples,
} from "../../src/shared/report.test-data";

vi.mock("./services", async (original) => ({
  ...(await original<typeof import("./services")>()),
  llmJson: vi.fn(),
}));
afterEach(() => vi.unstubAllGlobals());

// Published Goldman Sachs source excerpts, not application demo data.
const html = `<nav><p>999 nav</p></nav><h1>Global AI Investment Is Forecast to Exceed $1 Trillion in 2026</h1>
<p>That projection points to $1 trillion of AI-related investment around the globe in 2026, including $581 billion in the US.</p>
<p>Those estimates imply that AI capex will rise from 1.8% of GDP in the US (with global AI investment totaling 0.9% of global GDP) in 2026 to 2.5% of GDP in the US (1.3% globally) in 2027, with a further increase to 2.8% (1.4% globally) in 2028.</p>
<p>This article is being provided for educational purposes only.</p><p>999 related</p>`;
const chart = `<script>const options = {"layout.title":"Goldman Sachs Research estimates companies will invest $1.019 trillion globally in AI this year","y.title":"$ billions"};
var _Flourish_data_column_names = {"data":{"label":"Country","value":["US public","US private","Non-US public"]}},
_Flourish_data_metadata = {},
_Flourish_data = {"data":[{"label":"US","metadata":[],"value":[530,35,15]},{"label":"Global ex-US","metadata":[],"value":[234,67,138]}]},
_Flourish_visualisation_id = 29875854;</script>`;
const env = { ORCHESTRATOR_MODEL: "gpt-6.1-sol" } as Env;

describe("observed report figures", () => {
  it("extracts the captured Goldman Sachs page before researching its sources", async () => {
    expect(extractFigures(captured).map((figure) => figure.value)).toContain(
      "$1 Trillion",
    );
    const fetcher = vi.fn().mockResolvedValue(new Response(chart));
    vi.stubGlobal("fetch", fetcher);
    vi.mocked(llmJson).mockImplementationOnce(async (_env, opts) => {
      const input = JSON.parse(opts.input as string);
      expect(input.article).toContain("$581 billion");
      expect(input.article).not.toContain("Three New Stock Themes");
      expect(input.article).not.toContain("All rights reserved");
      opts.onSearchCalls?.(1);
      return { sources: [], traces: [] };
    });
    const report = await dissect(env, "run", {
      html: captured,
      url: "https://www.goldmansachs.com/insights/articles/global-investment-is-forecast-to-exceed-1-trillion-in-2026",
      capturedAt: "2026-10-17T04:18:32.733Z",
      hash: "capture-hash",
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://www.goldmansachs.com/infographics/v4/flourish/ai-companies-investment-estimate/index.html?auto=1",
      expect.any(Object),
    );
    expect(report.sources[0].title).toBe(
      "Global AI Investment Is Forecast to Exceed $1 Trillion in 2026",
    );
    expect(
      report.figures.some((figure) => figure.value === "$581 billion"),
    ).toBe(true);
    expect(
      report.figures.filter(
        (figure) => figure.group === "investment_breakdown",
      ),
    ).toHaveLength(6);
    for (const figure of report.figures.filter(
      (figure) => figure.sourceId === "article",
    )) {
      expect(
        cleanText(captured.slice(figure.location.start, figure.location.end)),
      ).toBe(figure.quote);
    }
    expect(report.figures.map((f) => f.value)).not.toContain("157");
    expect(report.sources[0]?.quote).toBe(report.sources[0]?.title);
    expect(
      report.figures
        .filter((figure) => figure.group === "investment_breakdown")
        .map((f) => f.breakdown),
    ).toEqual([
      { row: "US", column: "US public" },
      { row: "US", column: "US private" },
      { row: "US", column: "Non-US public" },
      { row: "Global ex-US", column: "US public" },
      { row: "Global ex-US", column: "US private" },
      { row: "Global ex-US", column: "Non-US public" },
    ]);
    expect(report.sources[1]).toMatchObject({
      id: "chart1",
      status: "in_article",
      quote:
        "Goldman Sachs Research estimates companies will invest $1.019 trillion globally in AI this year",
      reason: expect.stringContaining("6 values in 2 rows"),
    });
  });
  it("applies a model label only when it is short and invents no number", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(chart)));
    vi.mocked(llmJson).mockImplementationOnce(async (_env, opts) => {
      const input = JSON.parse(opts.input as string);
      expect(input.naming[0]).toMatchObject({
        id: "article_f1",
        value: "$1 Trillion",
        period: "2026",
        sentence: expect.stringContaining("Exceed $1 Trillion"),
      });
      opts.onSearchCalls?.(1);
      return {
        sources: [],
        traces: [],
        labels: [
          { figureId: "article_f1", label: "Global AI investment, 2026" },
          { figureId: "article_f2", label: "US AI investment, 2030" },
          { figureId: "article_f3", label: "x".repeat(71) },
          { figureId: "chart1_f0_0", label: "Overwritten chart cell" },
        ],
      };
    });
    const report = await dissect(env, "run", {
      html: captured,
      url: "https://www.goldmansachs.com/article",
      capturedAt: "2026-10-17T04:18:32.733Z",
      hash: "capture-hash",
    });
    const label = (id: string) =>
      report.figures.find((f) => f.id === id)?.label;
    expect(label("article_f1")).toBe("Global AI investment, 2026");
    expect(label("article_f2")).toBe(extractFigures(captured)[1]?.label);
    expect(label("article_f3")).toBe(extractFigures(captured)[2]?.label);
    expect(label("chart1_f0_0")).toBe("US: US public");
  });
  it.each([...uncertainQuantityExamples, ...incompleteQuantityExamples])(
    "keeps unsupported currency notation whole: $quote",
    ({ quote }) => {
      const article = extractFigures(`<p>${quote}</p>`);
      for (const heading of ["title", "subtitle"]) {
        const headlines = extractChart(
          chart
            .replace("layout.title", `layout.${heading}`)
            .replace("$1.019 trillion", quote),
          "chart1",
        ).filter((f) => f.group !== "investment_breakdown");
        for (const figures of [article, headlines]) {
          expect(figures).toHaveLength(1);
          expect(figures[0]).toMatchObject({
            value: "",
            unit: "",
            status: "not_observed",
          });
          expect(figures[0]?.quote).toContain(quote);
        }
      }
    },
  );
  it.each([
    "-2.5%",
    "−2.5%",
    "–2.5%",
    "+2.5%",
    "-$35 billion",
    "$-35 billion",
    "− €35 million",
    "£−35 million",
    ".5%",
    "-.5%",
    "$1,019 billion",
    "-$1,019.25 billion",
    "$-.5 billion",
  ])("preserves the complete signed article quantity %s", (value) => {
    const [figure] = extractFigures(`<p>Growth was ${value}.</p>`);
    expect(figure).toMatchObject({ value, status: "observed" });
    expect(figure?.quote).toContain(value);
  });
  it.each(["article", "main"])(
    "bounds figures and research to %s content with original offsets",
    async (tag) => {
      const reportQuote = "Investment reached USD 35 billion.";
      const footerQuote =
        "Revenue reached €99 billion according to Footer Research.";
      const captured = `<html><body><nav><p>Navigation 555</p></nav><main>${tag === "article" ? "<article>" : ""}<h1>Investment report</h1><p>${reportQuote}</p><iframe src="https://charts.example/report"></iframe><aside><p>Related revenue €88 billion</p><iframe src="https://charts.example/aside"></iframe></aside>${tag === "article" ? "</article><section><p>Related story €77 billion</p></section>" : ""}</main><footer><p>${footerQuote} <a href="https://footer.example/research">Footer Research</a></p><iframe src="https://charts.example/footer"></iframe></footer></body></html>`;
      const fetcher = vi.fn().mockResolvedValue(new Response("No chart data"));
      vi.stubGlobal("fetch", fetcher);
      vi.mocked(llmJson).mockImplementationOnce(async (_env, opts) => {
        const input = JSON.parse(opts.input as string);
        expect(input.article).toContain(reportQuote);
        expect(input.article).not.toContain("Related");
        expect(input.article).not.toContain("Footer Research");
        opts.onSearchCalls?.(1);
        return {
          sources: [
            {
              name: "Footer Research",
              articleQuote: footerQuote,
              url: "https://footer.example/research",
              quote: footerQuote,
              reason: "Unrelated",
            },
          ],
          traces: [],
        };
      });
      const report = await dissect(env, "run", {
        html: captured,
        url: "https://publisher.example/report",
        capturedAt: "2026-10-16T19:00:00.000Z",
        hash: "capture-hash",
      });
      expect(report.figures.map((figure) => figure.value)).toEqual([
        "USD 35 billion",
        "",
      ]);
      expect(report.sources.map((source) => source.id)).toEqual([
        "article",
        "chart1",
      ]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[0]).toBe("https://charts.example/report");
      for (const figure of report.figures) {
        expect(
          figure.quote.startsWith("<iframe")
            ? captured.slice(figure.location.start, figure.location.end)
            : cleanText(
                captured.slice(figure.location.start, figure.location.end),
              ),
        ).toBe(figure.quote);
      }
    },
  );
  it("does not treat an unscoped full page as report content", async () => {
    const captured =
      "<html><body><h1>Publisher</h1><section><p>Related revenue €99 billion</p></section></body></html>";
    expect(extractFigures(captured)).toEqual([]);
    await expect(
      dissect(env, "run", {
        html: captured,
        url: "https://publisher.example/report",
        capturedAt: "2026-10-16T19:00:00.000Z",
        hash: "capture-hash",
      }),
    ).rejects.toThrow("No report figures observed");
  });
  it("preserves an HTML-encoded minus sign", () => {
    expect(extractFigures("<p>Growth was &minus;2.5%.</p>")[0]).toMatchObject({
      value: "−2.5%",
      status: "observed",
    });
  });
  it.each([
    ["&#x2212;2.5%", "−2.5%"],
    ["&pound;-35 million", "£-35 million"],
    ["-&euro;.5 billion", "-€.5 billion"],
  ])("decodes quantity notation %s before extracting it", (encoded, value) => {
    expect(extractFigures(`<p>Growth was ${encoded}.</p>`)[0]).toMatchObject({
      value,
      status: "observed",
    });
  });
  it.each([
    "-$35 billion",
    "−$35 billion",
    "+$35 billion",
    "$-35 billion",
    "$1,019 billion",
    "-$1,019.25 billion",
    "$-.5 billion",
    ".5%",
  ])("preserves the complete signed chart headline %s", (value) => {
    const figures = extractChart(
      chart.replace("$1.019 trillion", value).replace("[530,", "[-530,"),
      "chart1",
    );
    expect(figures.at(-1)).toMatchObject({ value, status: "observed" });
    expect(figures[0]).toMatchObject({ value: "-530", status: "observed" });
  });
  it.each([
    "1,01 billion",
    "$1.019,5 billion",
    "1e3",
    "1/2",
    "--2.5%",
    "(2.5%)",
    "1 019 billion",
    "¥35 billion",
    "—$35 billion",
  ])(
    "marks unsupported %s notation without publishing a partial value in either text path",
    (value) => {
      const article = extractFigures(`<p>Growth was ${value}.</p>`);
      const headlines = extractChart(
        chart.replace("$1.019 trillion", value),
        "chart1",
      ).filter((f) => f.group !== "investment_breakdown");
      for (const figures of [article, headlines]) {
        expect(figures.length).toBeGreaterThan(0);
        expect(
          figures.every(
            (figure) => figure.status === "not_observed" && figure.value === "",
          ),
        ).toBe(true);
        expect(figures.every((figure) => figure.quote.includes(value))).toBe(
          true,
        );
      }
    },
  );
  it("uses the same complete quantity boundary for chart subtitles", () => {
    const figures = extractChart(
      chart
        .replace("layout.title", "layout.subtitle")
        .replace("$1.019 trillion", "-$1,019.5 billion"),
      "chart1",
    );
    expect(figures.at(-1)).toMatchObject({
      value: "-$1,019.5 billion",
      status: "observed",
      location: { path: "layout.subtitle" },
    });
  });
  it("lists each distinct figure once with its period and every location", () => {
    const figures = extractFigures(html);
    expect(figures.map((f) => [f.value, f.period])).toEqual([
      ["$1 Trillion", "2026"],
      ["$1 trillion", "2026"],
      ["$581 billion", "2026"],
      ["1.8%", "2026"],
      ["0.9%", "2026"],
      ["2.5%", "2027"],
      ["1.3%", "2027"],
      ["2.8%", "2028"],
      ["1.4%", "2028"],
    ]);
    expect(figures.map((f) => f.id)).toEqual(
      figures.map((_, i) => `article_f${i + 1}`),
    );
    expect(figures[0]?.mentions).toBeUndefined();
    for (const figure of figures) {
      expect(figure.status).toBe("observed");
      expect(figure.sourceId).toBe("article");
      for (const place of [figure, ...(figure.mentions ?? [])]) {
        expect(
          cleanText(html.slice(place.location.start, place.location.end)),
        ).toBe(place.quote);
        expect(place.quote).toContain(
          place === figure ? figure.value : figure.value.toLowerCase(),
        );
      }
      expect(figure.location.path).toBeTruthy();
    }
  });
  it.each([
    "Since 2022 cumulative AI investment will total $1.8 trillion by the end of this year.",
    "Cumulative AI investment of $1.8 trillion since 2022 is forecast by the end of this year.",
    "Investment since 2022 totals $1.8 trillion.",
  ])(
    "leaves cumulative start years unset in article and chart headlines: %s",
    (quote) => {
      const article = extractFigures(`<p>${quote}</p>`);
      for (const heading of ["title", "subtitle"]) {
        const headlines = extractChart(
          chart
            .replace("layout.title", `layout.${heading}`)
            .replace(
              "Goldman Sachs Research estimates companies will invest $1.019 trillion globally in AI this year",
              quote,
            ),
          "chart1",
        ).filter((f) => f.group === "key_figures");
        for (const figures of [article, headlines]) {
          expect(figures).toHaveLength(1);
          expect(figures[0]).toMatchObject({
            value: "$1.8 trillion",
            period: "",
          });
          expect(figures[0]?.label).not.toContain("2022");
        }
      }
    },
  );
  it("keeps distinct equal measures and supplies each occurrence's sentence for naming", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(chart)));
    vi.mocked(llmJson).mockImplementationOnce(async (_env, opts) => {
      const input = JSON.parse(opts.input as string);
      const amounts = input.naming.filter(
        (f: { value: string }) => f.value === "$200 billion",
      );
      expect(amounts).toHaveLength(2);
      expect(amounts[0].sentence).toContain("understates");
      expect(amounts[0].sentence).not.toContain("overstates");
      expect(amounts[1].sentence).toContain("overstates");
      expect(amounts[1].sentence).not.toContain("understates");
      const cumulative = input.naming.find(
        (f: { value: string }) => f.value === "$1.8 trillion",
      );
      expect(cumulative.period).toBe("");
      opts.onSearchCalls?.(1);
      return {
        sources: [],
        traces: [],
        labels: [
          { figureId: amounts[0].id, label: "Understated global AI capex" },
          { figureId: amounts[1].id, label: "Overstated US AI investment" },
          { figureId: cumulative.id, label: "Cumulative AI investment, 2022" },
        ],
      };
    });
    const report = await dissect(env, "run", {
      html: captured,
      url: "https://www.goldmansachs.com/article",
      capturedAt: "2026-10-17T04:18:32.733Z",
      hash: "capture-hash",
    });
    const amounts = report.figures.filter((f) => f.value === "$200 billion");
    expect(amounts.map((f) => f.label)).toEqual([
      "Understated global AI capex",
      "Overstated US AI investment",
    ]);
    for (const f of amounts) {
      expect(
        f.quote.slice(f.quantityStart, (f.quantityStart ?? 0) + f.value.length),
      ).toBe(f.value);
      expect(cleanText(captured.slice(f.location.start, f.location.end))).toBe(
        f.quote,
      );
    }
    expect(amounts[0]?.quantityStart).not.toBe(amounts[1]?.quantityStart);
    expect(
      report.figures.find((f) => f.value === "$1.8 trillion")?.label,
    ).not.toContain("2022");
  });
  it("retains repeated measurement locations within and across paragraphs", () => {
    const sentence = "Global capex reached $200 billion in 2026.";
    const figures = extractFigures(
      `<p>${sentence} ${sentence}</p><p>${sentence}</p>`,
    );
    expect(figures).toHaveLength(1);
    expect(figures[0]?.mentions).toHaveLength(2);
    expect(figures[0]?.mentions?.[0]?.quantityStart).not.toBe(
      figures[0]?.quantityStart,
    );
  });
  it("treats years and dates as context and skips site chrome", () => {
    const figures = extractFigures(captured);
    expect(figures.map((f) => f.value)).not.toContain("157");
    expect(figures.map((f) => f.value)).not.toContain("2026");
    expect(figures.map((f) => f.value)).not.toContain("2022");
    const cases = extractFigures(
      "<p>On 7 August 2026 the fund reported FY26 returns of 12% for 2022-2025, in Q3 and since March 5.</p>",
    );
    expect(cases.map((f) => [f.value, f.period])).toEqual([
      ["12%", "2022-2025"],
    ]);
  });
  it("starts a page-wide container at the title, before menus and mega-navigation", () => {
    const figures = extractFigures(
      `<div class="x--root-grid-main"><ul><li><a>157 Years of Excellence</a></li></ul><h1>Report</h1><p>Spend was $5 billion.</p></div>`,
    );
    expect(figures.map((f) => f.value)).toEqual(["$5 billion"]);
  });
  it("keeps one figure for a repeated value but every distinct place it appears", () => {
    const figures = extractFigures(
      "<p>Capex reached $794 billion in 2026.</p><p>Capex reached $794 billion in 2026.</p><p>Analysts repeat $794 billion for 2026.</p><p>Without a year, $794 billion differs.</p><p>Revenue was $5 billion; assets were $5 billion.</p>",
    );
    expect(
      figures.map((f) => [f.value, f.period, f.mentions?.length ?? 0]),
    ).toEqual([
      ["$794 billion", "2026", 1],
      ["$794 billion", "2026", 0],
      ["$794 billion", "", 0],
      ["$5 billion", "", 0],
      ["$5 billion", "", 0],
    ]);
  });
  it.each([
    ["2%-5% of GDP", "2%-5%", "%"],
    ["2% - 5% of GDP", "2% - 5%", "%"],
    ["between 2–5%", "2–5%", "%"],
    ["$5-10 billion", "$5-10 billion", "$ billion"],
    ["2.5%-3.5%", "2.5%-3.5%", "%"],
  ])("reads the range in %s as an observed figure", (text, value, unit) => {
    expect(extractFigures(`<p>It reached ${text}.</p>`)).toMatchObject([
      { value, unit, status: "observed", group: "key_figures" },
    ]);
  });
  it.each(["$5 billion-10%", "5 million-10 billion", "€5-$10 billion"])(
    "does not publish a range with mixed units: %s",
    (text) => {
      expect(extractFigures(`<p>It reached ${text}.</p>`)).toMatchObject([
        { value: "", status: "not_observed" },
      ]);
    },
  );
  it("reads a figure that opens a parenthetical but not an accounting negative", () => {
    expect(
      extractFigures("<p>Up 2.5% (1.3% globally) and (2.5%).</p>").map((f) => [
        f.value,
        f.status,
      ]),
    ).toEqual([
      ["2.5%", "observed"],
      ["1.3%", "observed"],
      ["", "not_observed"],
    ]);
  });
  it("reads the published chart dataset and precise headline without executing JavaScript", () => {
    const figures = extractChart(chart, "chart1");
    expect(figures.slice(0, 6).map((f) => [f.label, f.value, f.unit])).toEqual([
      ["US: US public", "530", "$ billions"],
      ["US: US private", "35", "$ billions"],
      ["US: Non-US public", "15", "$ billions"],
      ["Global ex-US: US public", "234", "$ billions"],
      ["Global ex-US: US private", "67", "$ billions"],
      ["Global ex-US: Non-US public", "138", "$ billions"],
    ]);
    expect(figures.at(-1)?.value).toBe("$1.019 trillion");
    for (const figure of figures) {
      expect(figure.status).toBe("observed");
      expect(figure.quote).toBeTruthy();
      expect(figure.location.end).toBeGreaterThan(figure.location.start);
    }
    expect(
      extractChart("<script>throw Error('never run')</script>", "chart"),
    ).toEqual([]);
  });
  it("marks unreadable chart data explicitly rather than inventing a breakdown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unreadable chart")),
    );
    vi.mocked(llmJson).mockImplementationOnce(async (_env, opts) => {
      opts.onSearchCalls?.(1);
      return { sources: [], traces: [] };
    });
    const report = await dissect(env, "run", {
      html: html.replace(
        "<p>That",
        '<iframe src="https://www.goldmansachs.com/chart"></iframe><p>That',
      ),
      url: "https://www.goldmansachs.com/article",
      capturedAt: "2026-10-16T19:00:00.000Z",
      hash: "captured-hash",
    });
    expect(
      report.figures.find((f) => f.group === "not_observed"),
    ).toMatchObject({ status: "not_observed", value: "", sourceId: "article" });
    expect(report.search).toMatchObject({ calls: 1, budget: 4 });
    expect(report.traces.every((t) => t.status === "not_found")).toBe(true);
    expect(vi.mocked(llmJson).mock.calls.at(-1)?.[1].webSearch).toBe(4);
  });
  it("keeps the report and records the real count when the provider overspends the search budget", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(chart)));
    const run = async (calls: number) => {
      vi.mocked(llmJson).mockImplementationOnce(async (_env, opts) => {
        opts.onSearchCalls?.(calls);
        return { sources: [], traces: [] };
      });
      return dissect(env, "run", {
        html: captured,
        url: "https://www.goldmansachs.com/article",
        capturedAt: "2026-10-17T04:18:32.733Z",
        hash: "capture-hash",
      });
    };
    const over = await run(6);
    expect(over.figures.length).toBeGreaterThan(0);
    expect(over.search).toMatchObject({ calls: 6, budget: 4 });
    expect(over.search.limitations).toContain(
      "The search used 6 calls against a budget of 4.",
    );
    expect((await run(4)).search.limitations).not.toContain("against a budget");
  });
  it("refuses an online match when its quote is absent from the fetched source", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<p>No matching value here.</p>")),
    );
    vi.mocked(llmJson).mockResolvedValueOnce({
      sources: [],
      traces: [
        {
          figureId: "article_f1",
          url: "https://www.goldmansachs.com/original",
          status: "matches",
          value: "$1 Trillion",
          quote: "$1 Trillion",
          reason: "model claim",
        },
      ],
    });
    const report = await dissect(env, "run", {
      html,
      url: "https://www.goldmansachs.com/article",
      capturedAt: "2026-10-16T19:00:00.000Z",
      hash: "hash",
    });
    expect(report.traces[0].status).toBe("not_found");
    expect(report.sources).toHaveLength(1);
  });
  it("does not fetch private addresses or follow redirects into them", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/secret" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(sourceFetch("http://127.0.0.1/")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(sourceFetch("https://www.goldmansachs.com/")).rejects.toThrow(
      "redirect",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it("retains a source link actually cited in the article when the original cannot be read", async () => {
  const quote =
    "But these estimates have several drawbacks, according to Goldman Sachs Research.";
  const captured = `<h1>Investment of $5 billion in 2026</h1><p>But these estimates have several drawbacks, according to <a href="/insights/goldman-sachs-research">Goldman Sachs Research</a>.</p>`;
  vi.mocked(llmJson).mockResolvedValueOnce({
    sources: [
      {
        name: "Goldman Sachs Research",
        articleQuote: quote,
        url: "https://www.goldmansachs.com/unobserved-report",
        title: "Unobserved title",
        publisher: "Unobserved publisher",
        published: "Unobserved date",
        quote: "",
        reason: "Underlying report unavailable",
      },
    ],
    traces: [],
  });
  const report = await dissect(env, "run", {
    html: captured,
    url: "https://www.goldmansachs.com/article",
    capturedAt: "2026-10-16T19:00:00.000Z",
    hash: "hash",
  });
  expect(report.sources[1]).toMatchObject({
    title: "Goldman Sachs Research",
    status: "named_not_found",
    url: "https://www.goldmansachs.com/insights/goldman-sachs-research",
    published: "",
    quote,
  });
});

it("does not call a normalized empty quotation an observed original source", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("<p>unrelated page</p>")),
  );
  vi.mocked(llmJson).mockResolvedValueOnce({
    sources: [
      {
        name: "Research",
        articleQuote: "Research investment of $5 billion",
        url: "https://www.goldmansachs.com/original",
        title: "Unobserved title",
        publisher: "Unobserved publisher",
        published: "Unobserved date",
        quote: "<script>untrusted</script>",
        reason: "Model claim",
      },
    ],
    traces: [],
  });
  const report = await dissect(env, "run", {
    html: "<h1>Research investment of $5 billion</h1>",
    url: "https://www.goldmansachs.com/article",
    capturedAt: "2026-10-16T19:00:00.000Z",
    hash: "hash",
  });
  expect(report.sources[1]?.status).toBe("named_not_found");
});

it.each([
  "https://www.goldmansachs.com/article?utm_source=research#figures",
  "https://goldmansachs.com/article/",
  "https://www.goldmansachs.com/%61rticle",
  "https://www.goldmansachs.com/chart?utm_source=research",
  "https://www.goldmansachs.com/published-chart/?view=full",
  "https://independent.example/article-redirect",
  "https://independent.example/chart-redirect",
])(
  "excludes article and chart aliases from both source promotions: %s",
  async (url) => {
    const quote = "Research investment of $5 billion";
    const captured = `<h1>${quote}</h1><iframe src="https://www.goldmansachs.com/chart"></iframe>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input === "https://www.goldmansachs.com/chart")
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://www.goldmansachs.com/published-chart",
            },
          });
        if (input.includes("independent.example"))
          return new Response(null, {
            status: 302,
            headers: {
              location: input.endsWith("article-redirect")
                ? "https://www.goldmansachs.com/article?redirected=true"
                : "https://www.goldmansachs.com/published-chart?redirected=true",
            },
          });
        return new Response(`<h1>${quote}</h1>${chart}`);
      }),
    );
    vi.mocked(llmJson).mockResolvedValueOnce({
      sources: [
        { name: "Research", articleQuote: quote, url, quote, reason: "Claim" },
      ],
      traces: [
        {
          figureId: "article_f1",
          url,
          quote,
          value: "$5 billion",
          status: "matches",
          reason: "Claim",
        },
      ],
    });
    const report = await dissect(env, "run", {
      html: captured,
      url: "https://www.goldmansachs.com/article",
      capturedAt: "2026-10-16T19:00:00.000Z",
      hash: "hash",
    });
    expect(report.sources.find((s) => s.title === "Research")?.status).toBe(
      "named_not_found",
    );
    expect(report.sources.some((s) => s.status === "traced_online")).toBe(
      false,
    );
    expect(report.traces[0]).toMatchObject({
      status: "not_found",
      sourceId: null,
    });
  },
);

const originalQuote = "AI investment is $35 billion in 2026 and will rise.";
it.each([
  ["$35 billion", originalQuote, "not_found"],
  ["$35 bn", originalQuote, "not_found"],
  ["$0.035 trillion", originalQuote, "not_found"],
  [
    "$35 billion",
    "AI investment is $135 billion in 2026 and will rise.",
    "not_found",
  ],
  [
    "$35 billion",
    "AI investment is $35 million in 2026 and will rise.",
    "not_found",
  ],
  [
    "$35 billion",
    "AI investment is €35 billion in 2026 and will rise.",
    "not_found",
  ],
  ["$35 billion", "AI investment: $35 billion in 2026.", "not_found"],
  [
    "$35 billion",
    "AI investment is $35 billion Canadian dollars in 2026 and will rise.",
    "not_found",
  ],
  [
    "$35 billion",
    "AI investment is $35 billion cad in 2026 and will rise.",
    "not_found",
  ],
  [
    "$35 billion",
    "AI investment is $35 billion (CAD) in 2026 and will rise.",
    "not_found",
  ],
  [
    "$35 billion",
    "AI investment is (CAD) $35 billion in 2026 and will rise.",
    "not_found",
  ],
  [
    "$35 billion",
    "AI investment is $35 billion [cad] in 2026 and will rise.",
    "not_found",
  ],
  ["35", originalQuote, "not_found", "chart1_f0_1"],
  ["", originalQuote, "not_found", "article_f1", "not_found"],
  [
    "35",
    '{"label":"US","metadata":[],"value":[530,35,15]}',
    "not_found",
    "chart1_f0_1",
  ],
])(
  "retains fetched evidence under the exact quote rule: %s in %s",
  async (value, quote, expected, figureId = "article_f1", status = "matches") => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(url.endsWith("/chart") ? chart : `<p>${quote}</p>`),
      ),
    );
    vi.mocked(llmJson).mockResolvedValueOnce({
      sources: [],
      traces: [
        {
          figureId,
          url: "https://independent.example/research",
          status,
          value,
          quote,
          reason: "Model comparison",
        },
      ],
    });
    const report = await dissect(env, "run", {
      html: `<h1>${originalQuote}</h1><iframe src="https://www.goldmansachs.com/chart"></iframe>`,
      url: "https://www.goldmansachs.com/article",
      capturedAt: "2026-10-16T19:00:00.000Z",
      hash: "hash",
    });
    const trace = report.traces.find((t) => t.figureId === figureId)!;
    expect(trace).toMatchObject({
      status: expected,
      quote,
      value: expected === "matches" ? value : "",
      completePassage: true,
    });
    expect(report.sources.find((s) => s.id === trace.sourceId)).toMatchObject({
      url: "https://independent.example/research",
      quote,
      status: "traced_online",
    });
    expect(report.figures.find((f) => f.id === "article_f1")).toMatchObject({
      value: "$35 billion",
      quote: originalQuote,
    });
    const input = JSON.parse(vi.mocked(llmJson).mock.calls.at(-1)![1].input);
    expect(
      input.figures.find((f: { id: string }) => f.id === "chart1_f0_1"),
    ).toMatchObject({
      value: "35",
      unit: "$ billions",
      quote: '{"label":"US","metadata":[],"value":[530,35,15]}',
    });
  },
);

it.each(["$", "£", ""])(
  "keeps identical %s passages unverified across different page currencies",
  async (currency) => {
    const quote = `Investment reaches ${currency}35 billion${currency ? "" : " dollars"}.`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(`<h1>CAD</h1><p>${quote}</p>`)),
    );
    vi.mocked(llmJson).mockResolvedValueOnce({
      sources: [],
      traces: [
        {
          figureId: "article_f1",
          url: "https://independent.example/research",
          status: "matches",
          value: `${currency}35 billion`,
          quote,
        },
      ],
    });
    const report = await dissect(env, "run", {
      html: `<h1>USD</h1><p>${quote}</p>`,
      url: "https://www.goldmansachs.com/article",
      capturedAt: "2026-10-16T19:00:00.000Z",
      hash: "hash",
    });
    expect(report.figures[0]).toMatchObject({
      value: currency ? `${currency}35 billion` : "",
      quote,
      status: currency ? "observed" : "not_observed",
    });
    expect(report.traces[0]).toMatchObject({
      status: "not_found",
      value: "",
      quote,
      completePassage: true,
    });
    expect(
      report.sources.find((s) => s.id === report.traces[0].sourceId),
    ).toMatchObject({
      status: "traced_online",
      quote,
    });
  },
);

it("accepts an independently fetched source for both source and figure provenance", async () => {
  const quote = "Research investment is €35 billion";
  const url = "https://www.goldmansachs.com/original-report?document=2026";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(`<p>${quote}</p>`)),
  );
  vi.mocked(llmJson).mockResolvedValueOnce({
    sources: [
      {
        name: "Research",
        articleQuote: quote,
        url,
        quote,
        reason: "Observed source",
      },
    ],
    traces: [
      {
        figureId: "article_f1",
        url,
        quote,
        value: "€35 billion",
        status: "matches",
        reason: "Observed value",
      },
    ],
  });
  const report = await dissect(env, "run", {
    html: `<h1>${quote}</h1>`,
    url: "https://www.goldmansachs.com/article",
    capturedAt: "2026-10-16T19:00:00.000Z",
    hash: "hash",
  });
  expect(
    report.sources
      .slice(1)
      .every((s) => s.status === "traced_online" && s.url === url),
  ).toBe(true);
  expect(report.traces[0]).toMatchObject({
    status: "matches",
    value: "€35 billion",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(uncertainQuantityExamples)(
  "keeps new uncertain comparisons unverified: $quote",
  async ({ quote, value }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(`<p>${quote}</p>`)),
    );
    vi.mocked(llmJson).mockResolvedValueOnce({
      sources: [],
      traces: [
        {
          figureId: "article_f1",
          url: "https://independent.example/research",
          status: "matches",
          value,
          quote,
        },
      ],
    });
    const report = await dissect(env, "run", {
      html: `<p>${quote}</p>`,
      url: "https://www.goldmansachs.com/article",
      capturedAt: "2026-10-16T19:00:00.000Z",
      hash: "hash",
    });
    expect(report.figures).toHaveLength(1);
    expect(report.figures[0]).toMatchObject({
      value: "",
      quote,
      status: "not_observed",
    });
    expect(report.traces[0]).toMatchObject({
      status: "not_found",
      value: "",
      quote,
      completePassage: true,
    });
  },
);

it.each(incompleteQuantityExamples)(
  "keeps unconsumed units unverified in new comparisons: $quote",
  async ({ quote, value, unit }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(`<p>${quote}</p>`)),
    );
    vi.mocked(llmJson).mockResolvedValueOnce({
      sources: [],
      traces: [
        {
          figureId: "article_f1",
          url: "https://independent.example/research",
          status: "matches",
          quote,
          value,
        },
      ],
    });
    const report = await dissect(env, "run", {
      html: `<p>${quote}</p>`,
      url: "https://www.goldmansachs.com/article",
      capturedAt: "2026-10-16T19:00:00.000Z",
      hash: "hash",
    });
    expect(report.figures[0]).toMatchObject({ quote, value, unit });
    expect(report.traces[0]).toMatchObject({
      status: "not_found",
      quote,
      value: "",
      completePassage: true,
    });
  },
);

it.each(repeatedQuantityExamples)(
  "keeps repeated quantities unverified in new comparisons: $quote",
  async ({ quote, value }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(`<p>${quote}</p>`)),
    );
    vi.mocked(llmJson).mockResolvedValueOnce({
      sources: [],
      traces: [1, 2].map((i) => ({
        figureId: `article_f${i}`,
        url: "https://independent.example/research",
        status: "matches",
        quote,
        value,
      })),
    });
    const report = await dissect(env, "run", {
      html: `<p>${quote}</p>`,
      url: "https://www.goldmansachs.com/article",
      capturedAt: "2026-10-16T19:00:00.000Z",
      hash: "hash",
    });
    expect(report.figures).toHaveLength(2);
    expect(report.traces).toHaveLength(2);
    expect(
      report.traces.every(
        (trace) => trace.status === "not_found" && trace.quote === quote,
      ),
    ).toBe(true);
  },
);

it.each(["h1", "h2", "p", "li", "figcaption", "td", "th", "blockquote"])(
  "compares and retains the full fetched %s passage when the model clips a qualifier",
  async (tag) => {
    const quote = "Investment reaches $35 billion";
    const fullQuote = `${quote} Canadian dollars`;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(`<${tag}>${quote} <em>Canadian dollars</em></${tag}>`),
        ),
    );
    vi.mocked(llmJson).mockResolvedValueOnce({
      sources: [
        {
          name: "Investment",
          articleQuote: quote,
          url: "https://independent.example/research",
          quote,
          reason: "Model citation",
        },
      ],
      traces: [
        {
          figureId: "article_f1",
          url: "https://independent.example/research",
          value: "$35 billion",
          quote,
          status: "matches",
        },
      ],
    });
    const report = await dissect(env, "run", {
      html: `<h1>${quote}</h1>`,
      url: "https://www.goldmansachs.com/article",
      capturedAt: "2026-10-16T19:00:00.000Z",
      hash: "hash",
    });
    expect(report.figures[0].quote).toBe(quote);
    expect(report.traces[0]).toMatchObject({
      status: "not_found",
      quote: fullQuote,
      value: "",
      completePassage: true,
    });
    expect(report.sources.slice(1).map((source) => source.quote)).toEqual([
      fullQuote,
      fullQuote,
    ]);
  },
);

it.each(["chart", "search", "source"])(
  "stops before further requests when cancelled during %s research",
  async (stage) => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      return new Response("<h1>Investment in 2026</h1>");
    });
    vi.stubGlobal("fetch", fetcher);
    vi.mocked(llmJson).mockClear();
    vi.mocked(llmJson).mockImplementationOnce(async (_env, opts) => {
      expect(opts.signal).toBe(controller.signal);
      if (stage === "search") controller.abort();
      return {
        sources: [],
        traces: [1, 2].map((i) => ({
          figureId: `article_f${i}`,
          url: `https://research.example/source${i}`,
          value: "$5 billion",
          quote: "Investment of $5 billion",
          status: "matches",
        })),
      };
    });
    const article = {
      html:
        "<h1>Investment of $5 billion</h1><p>Investment of $6 billion</p>" +
        (stage === "chart"
          ? '<iframe src="https://research.example/chart1"></iframe><iframe src="https://research.example/chart2"></iframe>'
          : ""),
      url: "https://www.goldmansachs.com/article",
      capturedAt: "2026-10-16T19:00:00.000Z",
      hash: "hash",
    };
    await expect(
      dissect(env, "run", article, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(stage === "search" ? 0 : 1);
    expect(llmJson).toHaveBeenCalledTimes(stage === "chart" ? 0 : 1);
    vi.mocked(llmJson).mockReset();
  },
);

it("aborts the in-flight OpenAI research request", async () => {
  const { llmJson: research } =
    await vi.importActual<typeof import("./services")>("./services");
  const controller = new AbortController();
  const fetcher = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const pending = research(env, {
    name: "research",
    instructions: "",
    input: "",
    schema: {},
    webSearch: 4,
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    "https://api.openai.com/v1/responses",
    expect.objectContaining({ signal: controller.signal }),
  );
});

it("hashes text and binary evidence with the same SHA-256 identity", async () => {
  const expected =
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  expect(await sha256("abc")).toBe(expected);
  expect(await sha256(new Uint8Array([97, 98, 99]).buffer)).toBe(expected);
});
