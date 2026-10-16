import { assert, describe, expect, it } from "vitest";
import { exactQuoteEvidence, ReportDissection } from "./report";

import { reportContractExample } from "./report.test-data";

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
  ["2026", "year", "2026 will rise", true],
  ["2026", "year", "12026 will rise", false],
  ["2026", "year", "2026.5 will rise", false],
  ["35", "$ billions", "35", false],
  ["35", "number", "35 widgets", false],
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

it("keeps saved comparisons without complete-passage evidence unverified", () => {
  const figure = ReportDissection.parse(reportContractExample).figures[0];
  assert(figure);
  expect(
    exactQuoteEvidence(figure, { value: figure.value, quote: figure.quote }),
  ).toBe(false);
});
