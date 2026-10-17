// The Goldman Sachs article is one real report used as a fixture; report dissection works for any report URL.
export const GOLDMAN_URL =
  "https://www.goldmansachs.com/insights/articles/global-investment-is-forecast-to-exceed-1-trillion-in-2026";

export const repeatedQuantityExamples = [
  "Revenue was USD 35 billion per year; losses were -USD 35 billion.",
  "Losses were -USD 35 billion; revenue was USD 35 billion.",
  "Revenue was USD 35 billion; assets were USD 35 billion.",
  "Revenue was USD 35 billion/year; assets were USD 35 billion.",
].map((quote) => ({ quote, value: "USD 35 billion", unit: "USD billion" }));

export const incompleteQuantityExamples = [
  "Investment was USD 35 billion/year.",
  "Investment was USD 35 billion /year.",
  "Investment was USD 35 billion per year.",
].map((quote) => ({ quote, value: "", unit: "" }));

export const uncertainQuantityExamples = [
  { quote: "Loss was (USD 35 billion).", value: "35 billion", unit: "billion" },
  { quote: "Loss was -USD 35 billion.", value: "35 billion", unit: "billion" },
  { quote: "Loss was - USD 35 billion.", value: "35 billion", unit: "billion" },
  { quote: "Loss was (35 billion USD).", value: "35 billion", unit: "billion" },
  { quote: "Investment was CHF 1'019 billion.", value: "1", unit: "number" },
  {
    quote: "Investment was CHF 1’019 billion.",
    value: "019 billion",
    unit: "billion",
  },
  {
    quote: "Investment was CHF 1 019 billion.",
    value: "019 billion",
    unit: "billion",
  },
  { quote: "Investment was CHF 1 · 019 billion.", value: "1", unit: "number" },
  { quote: "Cost is 2026 dollars.", value: "2026", unit: "year" },
  {
    quote: "Investment reaches 35 billion dollars.",
    value: "35 billion",
    unit: "billion",
  },
];

// Test-only data; no production module imports this file.
export const reportContractExample = {
  runId: "test-run",
  title: "Source report",
  completedAt: "2026-10-16T19:00:00.000Z",
  figures: [
    {
      id: "f1",
      value: "$581 billion",
      unit: "$ billion",
      label: "US AI investment",
      quote: "including $581 billion in the US",
      sourceId: "article",
      location: {
        kind: "html",
        start: 10,
        end: 80,
        path: "HTML characters 10–80",
      },
      status: "observed",
      reason: "Captured article",
      group: "key_figures",
    },
  ],
  sources: [
    {
      id: "article",
      url: GOLDMAN_URL,
      title: "Source report",
      publisher: "Goldman Sachs",
      published: "",
      quote: "including $581 billion in the US",
      quoteUrl: GOLDMAN_URL,
      capturedAt: "2026-10-16T19:00:00.000Z",
      hash: "real-capture-hash-in-production",
      status: "in_article",
      reason: "Captured article",
    },
  ],
  traces: [
    {
      figureId: "f1",
      sourceId: null,
      status: "not_found",
      value: "",
      quote: "",
      reason: "Not observed online",
    },
  ],
  edits: {},
  search: { calls: 2, budget: 4, limitations: "Bounded source search" },
  storage: { table: "report_run", recordId: "test-run" },
};
