import { describe, expect, it } from "vitest";
import { type ReaScan, reaEvidence } from "./rea";

const sha = "8b042780395cf27d1ffccdcdc0eb04635bc3f959a8286c85a1eaecefb7f9b0aa";
const files = { "0.js": "https://example.com/assets/main.js?v=secret" };

describe("reaEvidence", () => {
  it("turns each finding into code evidence with hash, locator and limits", () => {
    const scan: ReaScan = {
      findings: [
        {
          kind: "api",
          value: "/api/users",
          file: "0.js",
          sha256: sha,
          locator: "0.js:2:57",
          state: "observed",
          mechanism: "call:fetch",
        },
        {
          kind: "module",
          value: "0.js",
          file: "0.js",
          sha256: sha,
          locator: "0.js:1:0",
          state: "inferred",
          format: "esm",
          exports: ["App"],
        },
      ],
      omitted: 4,
      truncated: false,
      limitations: ["parsed as inert text"],
    };
    const [api, mod] = reaEvidence(scan, files);
    expect(api).toMatchObject({
      kind: "code",
      tool: "rea",
      status: "observed",
      hash: sha,
      locator: "0.js:2:57",
      summary:
        "API call /api/users (via call:fetch) in https://example.com/assets/main.js",
    });
    expect(api?.limits).toContain("not executed or observed at runtime");
    expect(api?.limits).toContain("4 further findings omitted");
    expect(api?.limits).toContain("parsed as inert text");
    expect(mod).toMatchObject({
      status: "inferred",
      summary:
        "Module 0.js (esm, exports App) in https://example.com/assets/main.js",
    });
  });

  it("records not_observed with the reason when REA fails or finds nothing", () => {
    const [failed] = reaEvidence(
      { error: "REA did not finish within 120s" },
      files,
    );
    expect(failed).toMatchObject({
      kind: "code",
      tool: "rea",
      status: "not_observed",
      limits: "REA failed: REA did not finish within 120s",
      summary: "REA analysis of 1 script bundles not run",
    });
    expect(reaEvidence(undefined, files)[0]?.status).toBe("not_observed");
    expect(
      reaEvidence(
        { findings: [], omitted: 0, truncated: true, limitations: [] },
        files,
      )[0],
    ).toMatchObject({
      status: "not_observed",
      limits: expect.stringContaining("truncated"),
    });
  });
});
