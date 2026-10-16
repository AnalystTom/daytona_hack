import { describe, expect, it } from "vitest";
import { CleanupReport, Pod, RunSandbox } from "../../shared/sandbox";
import { DaytonaError } from "./client";
import { fakeDaytona } from "./fake-daytona";
import {
  cleanupRun,
  createPod,
  getRunSandbox,
  type RunEnv,
  sendCaptainInput,
  startRunSandbox,
} from "./lifecycle";

const env: RunEnv = {
  runId: "run-1",
  apiUrl: "https://reversy.test",
  openaiApiKey: "sk-test",
  bridgeToken: "bridge-test",
};

describe("run sandbox lifecycle", () => {
  it("starts a labelled sandbox from the snapshot and boots Firstmate with the run secrets", async () => {
    const { deps, calls, execs } = fakeDaytona();
    const sandbox = RunSandbox.parse(await startRunSandbox(deps, env));
    expect(sandbox).toEqual({
      runId: "run-1",
      sandboxId: "sb1",
      state: "started",
      boot: "ready",
      bootLog: "boot line 1\nboot line 2",
      previewUrl: "https://4173-sb1.test",
    });
    expect(calls).toEqual([
      "create reversy-run",
      "session sb1 /opt/reversy/sandbox/boot.sh",
    ]);
    expect(execs[0]).toEqual({
      id: "sb1",
      command: "/opt/reversy/sandbox/save-env.sh",
      envs: {
        REVERSY_BOOT: "running",
        REVERSY_RUN_ID: "run-1",
        REVERSY_API_URL: "https://reversy.test",
        BRIDGE_TOKEN: "bridge-test",
        OPENAI_API_KEY: "sk-test",
      },
    });
  });

  it("returns the running sandbox instead of creating a second one", async () => {
    const { deps, calls } = fakeDaytona();
    await startRunSandbox(deps, env);
    calls.length = 0;
    expect((await startRunSandbox(deps, env)).sandboxId).toBe("sb1");
    expect(calls).toEqual([]);
  });

  it("restarts and reboots a stopped run sandbox", async () => {
    const { deps, calls, sandboxes } = fakeDaytona();
    await startRunSandbox(deps, env);
    Object.assign(sandboxes.get("sb1") ?? {}, { state: "stopped" });
    calls.length = 0;
    await startRunSandbox(deps, env);
    expect(calls).toEqual([
      "start sb1",
      "session sb1 /opt/reversy/sandbox/boot.sh",
    ]);
  });

  it("fails with the reason when the sandbox errors while starting", async () => {
    const { deps, add } = fakeDaytona();
    const broken = add(
      { "reversy.run": "run-1", "reversy.role": "run" },
      "error",
    );
    await expect(startRunSandbox(deps, env)).rejects.toThrow(
      `Sandbox ${broken.id} start failed in state error`,
    );
  });

  it("reports no sandbox for an unknown run", async () => {
    const { deps } = fakeDaytona();
    expect(await getRunSandbox(deps, "nope")).toBeUndefined();
  });

  it("forwards captain input to Firstmate through captain-input.sh", async () => {
    const { deps, execs } = fakeDaytona();
    await startRunSandbox(deps, env);
    await sendCaptainInput(deps, "run-1", {
      kind: "approved_spec",
      text: "Build the landing page.",
    });
    expect(execs.at(-1)).toEqual({
      id: "sb1",
      command: "/opt/reversy/sandbox/captain-input.sh",
      envs: {
        CAPTAIN_KIND: "approved_spec",
        CAPTAIN_TEXT: "Build the landing page.",
      },
    });
  });

  it("refuses captain input for a run without a started sandbox", async () => {
    const { deps, sandboxes } = fakeDaytona();
    await expect(
      sendCaptainInput(deps, "run-1", { kind: "chat", text: "hi" }),
    ).rejects.toMatchObject({ status: 404 });
    await startRunSandbox(deps, env);
    Object.assign(sandboxes.get("sb1") ?? {}, { state: "stopped" });
    await expect(
      sendCaptainInput(deps, "run-1", { kind: "chat", text: "hi" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("forks a pod when Daytona allows it and relabels the fork", async () => {
    const { deps, sandboxes, execs, calls } = fakeDaytona();
    await startRunSandbox(deps, env);
    const pod = Pod.parse(await createPod(deps, env));
    expect(pod).toEqual({ podId: "sb2", kind: "fork", parentSandboxId: "sb1" });
    expect(sandboxes.get("sb2")?.labels).toEqual({
      "reversy.run": "run-1",
      "reversy.role": "pod",
      "reversy.pod-kind": "fork",
    });
    expect(execs.at(-1)).toEqual({
      id: "sb2",
      command: "/opt/reversy/sandbox/save-env.sh",
      envs: { REVERSY_POD_ID: "sb2" },
    });
    expect(calls).not.toContain("stop sb1");
    // The fork no longer looks like the run sandbox.
    expect((await getRunSandbox(deps, "run-1"))?.sandboxId).toBe("sb1");
  });

  it("falls back to a snapshot copy when fork is refused, and restarts the parent", async () => {
    const { deps, sandboxes, calls, execs } = fakeDaytona({ forkStatus: 400 });
    await startRunSandbox(deps, env);
    const pod = await createPod(deps, env);
    expect(pod).toEqual({ podId: "sb2", kind: "copy", parentSandboxId: "sb1" });
    const snapshot = sandboxes.get("sb2")?.labels["reversy.copy-snapshot"];
    expect(snapshot).toMatch(/^reversy-copy-sb1-\d+$/);
    expect(sandboxes.get("sb2")?.labels["reversy.pod-kind"]).toBe("copy");
    expect(calls).toEqual([
      "create reversy-run",
      "session sb1 /opt/reversy/sandbox/boot.sh",
      "fork sb1",
      "stop sb1",
      `snapshot sb1 ${snapshot}`,
      "start sb1",
      "session sb1 /opt/reversy/sandbox/boot.sh",
      `create ${snapshot}`,
      "session sb2 /opt/reversy/sandbox/boot.sh",
    ]);
    expect(sandboxes.get("sb1")?.state).toBe("started");
    expect(
      execs.find((e) => e.id === "sb2" && e.command.endsWith("save-env.sh"))
        ?.envs?.REVERSY_POD_ID,
    ).toBe("sb2");
  });

  it("retries boot when the running sandbox's boot failed", async () => {
    const { deps, calls } = fakeDaytona();
    await startRunSandbox(deps, env);
    const exec = deps.daytona.exec;
    let failed = true;
    deps.daytona.exec = async (id, command, options) => {
      if (command.endsWith("status.sh") && failed) {
        failed = false;
        return { exitCode: 0, result: "failed\nno network" };
      }
      return exec(id, command, options);
    };
    calls.length = 0;
    expect((await startRunSandbox(deps, env)).boot).toBe("ready");
    expect(calls).toEqual(["session sb1 /opt/reversy/sandbox/boot.sh"]);
  });

  it("boots a started sandbox that was never booted", async () => {
    const { deps, calls } = fakeDaytona();
    await startRunSandbox(deps, env);
    const exec = deps.daytona.exec;
    let unknown = true;
    deps.daytona.exec = async (id, command, options) => {
      if (command.endsWith("status.sh") && unknown) {
        unknown = false;
        return { exitCode: 0, result: "unknown\n" };
      }
      return exec(id, command, options);
    };
    calls.length = 0;
    expect((await startRunSandbox(deps, env)).boot).toBe("ready");
    expect(calls).toEqual(["session sb1 /opt/reversy/sandbox/boot.sh"]);
  });

  it("marks a boot that could not start failed, so the next start retries it", async () => {
    const { deps, calls } = fakeDaytona();
    await startRunSandbox(deps, env);
    let status = "failed";
    const exec = deps.daytona.exec;
    deps.daytona.exec = async (id, command, options) => {
      if (command.endsWith("status.sh")) {
        return { exitCode: 0, result: `${status}\n` };
      }
      if (options?.envs?.REVERSY_BOOT) status = options.envs.REVERSY_BOOT;
      return exec(id, command, options);
    };
    const session = deps.daytona.startSessionCommand;
    deps.daytona.startSessionCommand = async () => {
      deps.daytona.startSessionCommand = session;
      throw new DaytonaError("toolbox unavailable", 503);
    };
    await expect(startRunSandbox(deps, env)).rejects.toThrow(
      "toolbox unavailable",
    );
    expect(status).toBe("failed");
    calls.length = 0;
    expect((await startRunSandbox(deps, env)).boot).toBe("running");
    expect(calls).toEqual(["session sb1 /opt/reversy/sandbox/boot.sh"]);
  });

  it("does not fall back to a copy when work after a successful fork fails", async () => {
    const { deps, calls } = fakeDaytona();
    await startRunSandbox(deps, env);
    deps.daytona.setLabels = async () => {
      throw new DaytonaError("bad label", 400);
    };
    await expect(createPod(deps, env)).rejects.toThrow("bad label");
    expect(calls).not.toContain("stop sb1");
  });

  it("removes the copy snapshot when creating the copy fails", async () => {
    const { deps, snapshots } = fakeDaytona({ forkStatus: 400 });
    await startRunSandbox(deps, env);
    const create = deps.daytona.create;
    deps.daytona.create = async (input) => {
      if (input.snapshot.startsWith("reversy-copy-")) {
        throw new DaytonaError("quota exceeded", 403);
      }
      return create(input);
    };
    await expect(createPod(deps, env)).rejects.toThrow("quota exceeded");
    expect(snapshots.size).toBe(0);
  });

  it("removes the copy snapshot when the snapshot never becomes active", async () => {
    const { deps, snapshots, sandboxes } = fakeDaytona({ forkStatus: 400 });
    await startRunSandbox(deps, env);
    deps.daytona.getSnapshot = async (name) => ({
      id: name,
      name,
      state: "build_failed",
    });
    await expect(createPod(deps, env)).rejects.toThrow(/build_failed/);
    expect(snapshots.size).toBe(0);
    expect(sandboxes.get("sb1")?.state).toBe("started");
  });

  it("removes the copy snapshot when restarting the parent fails, keeping that error", async () => {
    const { deps, snapshots } = fakeDaytona({ forkStatus: 400 });
    await startRunSandbox(deps, env);
    deps.daytona.start = async () => {
      throw new DaytonaError("start refused", 500);
    };
    await expect(createPod(deps, env)).rejects.toThrow("start refused");
    expect(snapshots.size).toBe(0);
  });

  it("does not mask fork failures that are not refusals", async () => {
    const { deps } = fakeDaytona({ forkStatus: 401 });
    await startRunSandbox(deps, env);
    await expect(createPod(deps, env)).rejects.toMatchObject({ status: 401 });
  });

  it("cleans up pods before the run sandbox, with copy snapshots, and reports success", async () => {
    const { deps, sandboxes, snapshots, calls } = fakeDaytona({
      forkStatus: 400,
    });
    await startRunSandbox(deps, env);
    await createPod(deps, env);
    const snapshot = [...snapshots.keys()][0];
    calls.length = 0;
    const report = CleanupReport.parse(await cleanupRun(deps, "run-1"));
    expect(report).toEqual({
      runId: "run-1",
      status: "succeeded",
      removed: ["sb2", snapshot, "sb1"],
      failures: [],
    });
    expect(calls).toEqual([
      "remove sb2",
      `removeSnapshot ${snapshot}`,
      "remove sb1",
    ]);
    expect(sandboxes.size).toBe(0);
  });

  it("reports cleanup failure with the reason", async () => {
    const { deps } = fakeDaytona();
    await startRunSandbox(deps, env);
    deps.daytona.remove = async () => {
      throw new DaytonaError("Daytona DELETE failed with 500", 500);
    };
    const report = await cleanupRun(deps, "run-1");
    expect(report.status).toBe("failed");
    expect(report.failures).toEqual([
      { id: "sb1", error: "DaytonaError: Daytona DELETE failed with 500" },
    ]);
  });
});
