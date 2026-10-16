import { GOLDMAN_URL } from "./report";

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
