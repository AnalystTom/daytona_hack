import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without type declarations
import { project } from "./rea-scan.mjs";

// Trimmed real output of `rea analyze-javascript-application` (rea-agents 6.x) on a two-file app.
const raw = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/rea-analyze.json"), "utf8"),
);

describe("rea-scan.mjs", () => {
  it("projects REA's graph to API calls, routes and modules with hashes and locators", () => {
    const scan = project(raw);
    expect(scan.findings.map((f: { kind: string }) => f.kind)).toEqual([
      "api",
      "api",
      "route",
      "module",
      "module",
    ]);
    expect(scan.findings[0]).toEqual({
      kind: "api",
      value: "/api/users",
      file: "main.js",
      sha256:
        "8b042780395cf27d1ffccdcdc0eb04635bc3f959a8286c85a1eaecefb7f9b0aa",
      locator: "main.js:2:57",
      state: "observed",
      mechanism: "call:fetch",
    });
    expect(scan.findings[3]).toMatchObject({
      value: "main.js",
      exports: ["App"],
    });
    expect(scan.limitations.length).toBeGreaterThan(0);
    expect(scan.omitted).toBe(0);
  });

  it("caps findings, keeping API calls first and counting the rest", () => {
    const scan = project(raw, 2);
    expect(scan.findings.map((f: { value: string }) => f.value)).toEqual([
      "/api/users",
      "/api/plans",
    ]);
    expect(scan.omitted).toBe(3);
  });

  it("reports an error for output without a graph", () => {
    expect(project({ error: "x" })).toEqual({
      error: "REA returned no application graph",
    });
  });

  it("prints an error instead of failing when REA cannot run", () => {
    const out = execFileSync(
      process.execPath,
      [join(import.meta.dirname, "rea-scan.mjs"), "/nonexistent", "5"],
      { env: { PATH: "/nonexistent-bin" }, encoding: "utf8" },
    );
    expect(JSON.parse(out).error).toMatch(/^REA could not start/);
  });
});
