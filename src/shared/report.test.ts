import { describe, expect, it } from "vitest";
import { ReportDissection } from "./report";

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
