import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanText,
  dissect,
  extractChart,
  extractFigures,
  sourceFetch,
} from "./dissection";
import { llmJson } from "./services";
import type { Env } from "./types";

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
  it("extracts every occurrence, including periods and percentages, without the old eight-figure cap", () => {
    const figures = extractFigures(html);
    expect(figures.length).toBeGreaterThan(8);
    expect(figures.map((f) => f.value)).toEqual([
      "$1 Trillion",
      "2026",
      "$1 trillion",
      "2026",
      "$581 billion",
      "1.8%",
      "0.9%",
      "2026",
      "2.5%",
      "1.3%",
      "2027",
      "2.8%",
      "1.4%",
      "2028",
    ]);
    for (const figure of figures) {
      expect(figure.status).toBe("observed");
      expect(figure.sourceId).toBe("article");
      expect(
        cleanText(html.slice(figure.location.start, figure.location.end)),
      ).toBe(figure.quote);
      expect(figure.quote).toContain(figure.value);
      expect(figure.location.path).toBeTruthy();
    }
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
  const captured = `<h1>Investment in 2026</h1><p>But these estimates have several drawbacks, according to <a href="/insights/goldman-sachs-research">Goldman Sachs Research</a>.</p>`;
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
        articleQuote: "Research investment in 2026",
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
    html: "<h1>Research investment in 2026</h1>",
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
    const quote = "Research investment in 2026";
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
          value: "2026",
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
  ["$35 billion", originalQuote, "matches"],
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
  ["2026", originalQuote, "matches", "article_f2"],
  [
    "2026",
    "AI investment is $35 billion in 12026 and will rise.",
    "not_found",
    "article_f2",
  ],
  [
    "2027",
    "AI investment is $35 billion in 2027 and will rise.",
    "not_found",
    "article_f2",
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

it("accepts an independently fetched source for both source and figure provenance", async () => {
  const quote = "Research investment in 2026";
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
        value: "2026",
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
  expect(report.traces[0]).toMatchObject({ status: "matches", value: "2026" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
