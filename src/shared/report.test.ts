import { assert, describe, expect, it } from "vitest";
import {
  exactQuoteEvidence,
  ReportDissection,
  reportQuantities,
} from "./report";

import {
  reportContractExample,
  uncertainQuantityExamples,
  incompleteQuantityExamples,
} from "./report.test-data";

describe("report dashboard contract", () => {
  it("requires source quotation, location, status and an existing source", () => {
    expect(ReportDissection.safeParse(reportContractExample).success).toBe(
      true,
    );
    for (const change of [
      { quote: "" },
      { location: undefined },
      { status: "" },
      { sourceId: "missing" },
    ]) {
      expect(
        ReportDissection.safeParse({
          ...reportContractExample,
          figures: [{ ...reportContractExample.figures[0], ...change }],
        }).success,
      ).toBe(false);
    }
  });
  it("keeps captured originals when an edit or labelled replay is received", () => {
    const result = ReportDissection.parse({
      ...reportContractExample,
      edits: { f1: { label: "Edited", value: "User value" } },
      replay: {
        runId: "original",
        completedAt: reportContractExample.completedAt,
        reason: "Capture unavailable",
      },
    });
    expect(result.figures[0]?.value).toBe("$581 billion");
    expect(result.edits.f1?.value).toBe("User value");
    expect(result.replay?.runId).toBe("original");
  });
});

it("rejects observed sources without a capture hash and exceeded research budgets", () => {
  expect(
    ReportDissection.safeParse({
      ...reportContractExample,
      sources: [{ ...reportContractExample.sources[0], hash: "" }],
    }).success,
  ).toBe(false);
  expect(
    ReportDissection.safeParse({
      ...reportContractExample,
      search: { ...reportContractExample.search, calls: 5 },
    }).success,
  ).toBe(false);
});

it.each([
  ["2026", "year", "2026 will rise", false],
  ["2026", "year", "12026 will rise", false],
  ["2026", "year", "2026.5 will rise", false],
  ["35", "$ billions", "35", false],
  ["35", "number", "35 widgets", false],
  ["$35 billion", "$ billion", "Investment reaches $35 billion.", false],
  ["£35 billion", "£ billion", "Investment reaches £35 billion.", false],
  ["€35 billion", "€ billion", "Investment reaches €35 billion.", true],
  ["-2.5%", "%", "Growth was -2.5%.", false],
  ["2.5%", "%", "Growth was -2.5%.", false],
  ["35 billion", "billion", "Investment reaches 35 billion dollars.", false],
  ["USD 35 billion", "USD billion", "Investment reaches USD 35 billion.", true],
  ["35 billion CAD", "CAD billion", "Investment reaches 35 billion CAD.", true],
  ["USD $35 billion", "$ billion", "Investment reaches USD $35 billion.", true],
  ["GBP £35 billion", "£ billion", "Investment reaches GBP £35 billion.", true],
  ["$35 billion", "$ billion", "Investment reaches EUR $35 billion.", false],
  ["35 billion", "billion", "Investment reaches USD 35 billion CAD.", false],
  ["35 billion", "billion", "USD 35 billion and CAD 35 billion.", false],
  ["5%", "%", "Growth was .5%.", false],
  [".5%", "%", "Growth was .5%.", false],
  ["$1", "$ number", "Investment reaches USD $1,019 billion.", false],
  [
    "-$1,019.5 billion",
    "$ billion",
    "Investment reaches USD -$1,019.5 billion.",
    false,
  ],
])(
  "requires complete values and explicit units in exact quote evidence",
  (value, unit, quote, expected) => {
    const figure = ReportDissection.parse(reportContractExample).figures[0];
    assert(figure);
    expect(
      exactQuoteEvidence(
        { ...figure, value, unit, quote },
        { value, quote, completePassage: true },
      ),
    ).toBe(expected);
  },
);

it.each(uncertainQuantityExamples)(
  "rejects incomplete or uncertain evidence: $quote",
  ({ quote, value, unit }) => {
    expect(reportQuantities(quote)).toEqual([
      { value: "", unit: "", currency: "", status: "not_observed" },
    ]);
    const figure = ReportDissection.parse(reportContractExample).figures[0]!;
    expect(
      exactQuoteEvidence(
        { ...figure, value, unit, quote },
        { value, quote, completePassage: true },
      ),
    ).toBe(false);
  },
);

it("does not label bare integers as years or match them without currency", () => {
  expect(reportQuantities("In 2026, costs rose.")).toMatchObject([
    { value: "2026", unit: "number" },
  ]);
});

it.each(incompleteQuantityExamples)(
  "never verifies an amount with an unconsumed unit: $quote",
  ({ quote, value, unit }) => {
    const figure = ReportDissection.parse(reportContractExample).figures[0]!;
    expect(
      exactQuoteEvidence(
        { ...figure, quote, value, unit },
        { quote, value, completePassage: true },
      ),
    ).toBe(false);
  },
);

it.each([
  ["USD 35 billion", "USD billion", "Investment reaches CAD 35 billion."],
  ["USD 35 billion", "USD billion", "Investment reaches USD 35 million."],
  ["USD 35 billion", "USD billion", "Investment reaches USD -35 billion."],
  ["USD 35 billion", "USD million", "Investment reaches USD 35 billion."],
])(
  "rejects independent currency, scale, sign or unit changes",
  (value, unit, quote) => {
    const figure = ReportDissection.parse(reportContractExample).figures[0]!;
    expect(
      exactQuoteEvidence(
        { ...figure, value, unit, quote: "Investment reaches USD 35 billion." },
        { value, quote, completePassage: true },
      ),
    ).toBe(false);
  },
);

it("keeps saved comparisons without complete-passage evidence unverified", () => {
  const figure = ReportDissection.parse(reportContractExample).figures[0];
  assert(figure);
  expect(
    exactQuoteEvidence(figure, { value: figure.value, quote: figure.quote }),
  ).toBe(false);
});
