import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const run = (script: string, home: string, envs: Record<string, string> = {}) =>
  execFileSync(join(import.meta.dirname, script), {
    env: { PATH: process.env.PATH, HOME: home, ...envs },
    encoding: "utf8",
  });

describe("save-env.sh", () => {
  it("marks a starting boot running so status.sh no longer reports the last outcome", () => {
    const home = mkdtempSync(join(tmpdir(), "save-env-"));
    mkdirSync(join(home, ".reversy"));
    writeFileSync(join(home, ".reversy", "boot.status"), "failed\n");
    run("save-env.sh", home, { REVERSY_POD_ID: "sb2" });
    expect(run("status.sh", home).split("\n")[0]).toBe("failed");

    run("save-env.sh", home, { REVERSY_BOOT: "1", REVERSY_RUN_ID: "run-1" });
    expect(run("status.sh", home).split("\n")[0]).toBe("running");
    expect(
      readFileSync(join(home, ".reversy", "env", "REVERSY_RUN_ID"), "utf8"),
    ).toBe("run-1");
  });
});
