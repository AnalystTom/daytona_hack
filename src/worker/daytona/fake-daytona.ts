// Test fixture only: an in-memory Daytona for lifecycle and route tests, never used by the Worker.
import {
  type CreateSandboxInput,
  type DaytonaClient,
  DaytonaError,
  type Labels,
  type Sandbox,
} from "./client";
import type { Deps } from "./lifecycle";

// In-memory stand-in for Daytona: sandboxes settle into their target state on the next read.
export function fakeDaytona({ forkStatus }: { forkStatus?: number } = {}) {
  const sandboxes = new Map<string, Sandbox & { settle?: string }>();
  const snapshots = new Map<string, string>();
  const calls: string[] = [];
  const execs: { id: string; command: string; envs?: Labels }[] = [];
  let next = 1;
  const add = (labels: Labels, settle = "started") => {
    const sandbox = {
      id: `sb${next++}`,
      name: "",
      labels,
      state: "creating",
      settle,
    };
    sandboxes.set(sandbox.id, sandbox);
    return { ...sandbox };
  };
  const must = (id: string) => {
    const sandbox = sandboxes.get(id);
    if (!sandbox) throw new DaytonaError("not found", 404);
    return sandbox;
  };
  const client: DaytonaClient = {
    create: async (input: CreateSandboxInput) => {
      calls.push(`create ${input.snapshot}`);
      return add(input.labels);
    },
    get: async (id) => {
      const sandbox = must(id);
      if (sandbox.settle) {
        sandbox.state = sandbox.settle;
        sandbox.settle = undefined;
      }
      return { ...sandbox };
    },
    list: async (labels) =>
      [...sandboxes.values()]
        .filter((s) =>
          Object.entries(labels).every(([k, v]) => s.labels[k] === v),
        )
        .map((s) => ({ ...s })),
    start: async (id) => {
      calls.push(`start ${id}`);
      Object.assign(must(id), { state: "starting", settle: "started" });
      return { ...must(id) };
    },
    stop: async (id) => {
      calls.push(`stop ${id}`);
      Object.assign(must(id), { state: "stopping", settle: "stopped" });
      return { ...must(id) };
    },
    remove: async (id) => {
      calls.push(`remove ${id}`);
      must(id);
      sandboxes.delete(id);
      return { id, name: "", labels: {} };
    },
    fork: async (id) => {
      calls.push(`fork ${id}`);
      if (forkStatus) throw new DaytonaError("fork refused", forkStatus);
      return add({ ...must(id).labels });
    },
    snapshot: async (id, name) => {
      calls.push(`snapshot ${id} ${name}`);
      Object.assign(must(id), { state: "snapshotting", settle: "stopped" });
      snapshots.set(name, "active");
      return { ...must(id) };
    },
    getSnapshot: async (name) => ({
      id: name,
      name,
      state: snapshots.get(name) ?? "missing",
    }),
    removeSnapshot: async (name) => {
      calls.push(`removeSnapshot ${name}`);
      snapshots.delete(name);
    },
    setLabels: async (id, labels) => {
      must(id).labels = labels;
      return { labels };
    },
    previewLink: async (id, port) => ({ url: `https://${port}-${id}.test` }),
    exec: async (id, command, options = {}) => {
      execs.push({ id, command, envs: options.envs });
      return command.endsWith("status.sh")
        ? { exitCode: 0, result: "ready\nboot line 1\nboot line 2" }
        : { exitCode: 0, result: "" };
    },
    startSessionCommand: async (id, _session, command) => {
      calls.push(`session ${id} ${command}`);
      return "cmd";
    },
  };
  const deps: Deps = {
    daytona: client,
    snapshot: "reversy-run",
    sleep: async () => {},
  };
  return { deps, sandboxes, snapshots, calls, execs, add };
}
