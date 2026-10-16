import { afterEach, describe, expect, it, vi } from "vitest";
import { Run } from "../src/run";
import { recordRunEvent } from "../../src/worker/records/records";
import { MemoryRunStore } from "../../src/worker/store/memory";
import type { Env, RunEvent, RunRecord, Task } from "../src/types";

// A Durable Object state in memory; Daytona and OpenAI are answered by a mocked fetch.
function fakeRun(
  state: object,
  overrides: Partial<Env> = {},
  initialAlarm: number | null = null,
) {
  const pending: Promise<unknown>[] = [];
  const snapshots: object[] = [structuredClone(state)];
  const data = new Map<string, unknown>([["state", state]]);
  let ready: Promise<unknown> = Promise.resolve();
  let scheduled = initialAlarm;
  let transacting: Promise<unknown> = Promise.resolve();
  const storage = {
    get: async (key: string) => data.get(key),
    list: async ({ prefix, start }: { prefix: string; start: string }) =>
      new Map(
        [...data]
          .filter(([key]) => key.startsWith(prefix) && key >= start)
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    put: async (key: string, value: unknown) => {
      data.set(key, value);
      if (key === "state") snapshots.push(structuredClone(value as object));
    },
    getAlarm: async () => scheduled,
    setAlarm: async (at: number) => {
      scheduled = at;
    },
    transaction: (
      fn: (txn: {
        getAlarm: () => Promise<number | null>;
        setAlarm: (at: number) => Promise<void>;
      }) => Promise<void>,
    ) => {
      const result = transacting.then(() => fn(storage));
      transacting = result.catch(() => {});
      return result;
    },
  };
  const ctx = {
    storage,
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      ready = fn();
    },
  };
  const env = {
    DAYTONA_API_URL: "https://daytona.test",
    OPENAI_API_KEY: "test",
    ORCHESTRATOR_MODEL: "gpt-test",
    VERIFIER_MODEL: "gpt-test",
    ...overrides,
  } as Env;
  const run = new Run(ctx as never, env);
  const alarm = run.alarm.bind(run);
  run.alarm = async () => {
    scheduled = null;
    await alarm();
  };
  return {
    run,
    scheduled: () => scheduled,
    state: () => data.get("state") as any,
    persisted: () => structuredClone(snapshots.at(-1)) as any,
    ready,
    flush: () => Promise.all(pending),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const variant = (id: string, pod: "fork" | "copy" = "fork") => ({
  id,
  title: `Alternative ${id}`,
  explanation: "An alternative layout",
  change: "Update the landing page",
  pod,
  sandboxId: pod === "fork" ? `sb${Number(id.slice(1)) + 1}` : "sb1",
  dir: pod === "fork" ? "/home/daytona/app" : `/home/daytona/variants/${id}`,
  status: "ready",
  snapshot: "abc",
});

const calls: string[] = [];
function mockFetch(verdict?: object, status = 200) {
  const stopped = new Set<string>();
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? "GET"} ${input}`);
    if (input.endsWith("/stop")) stopped.add(input.slice(0, -5));
    if (/^https:\/\/daytona.test\/sandbox\/[^/]+$/.test(input))
      return Response.json({
        state: stopped.has(input) ? "stopped" : "started",
      });
    if (input.endsWith("/toolbox-proxy-url"))
      return Response.json({ url: "https://toolbox.test" });
    if (input.endsWith("/process/execute"))
      return Response.json({ exitCode: 0, result: "" });
    if (input === "https://api.openai.com/v1/responses")
      return Response.json(
        { output_text: JSON.stringify(verdict) },
        { status },
      );
    if (input.startsWith("https://3000-"))
      return new Response("<main>rebuild</main>");
    return Response.json({});
  });
}

const task = (id: string, status: Task["status"]): Task => ({
  id,
  title: `Task ${id}`,
  brief: "",
  outOfScope: "",
  acceptance: [],
  evidence: ["ev_001"],
  owns: ["sections/hero.html"],
  dependsOn: [],
  status,
  attempts: 1,
  branch: `task/${id}`,
});

const verifiedVariantTask = (id: string): Task => ({
  ...task(id, "merged"),
  variant: id,
  verification: true,
});

const baseState = (startedAt: string, phase: string, tasks: Task[]) => ({
  id: "run-1",
  startedAt,
  phase,
  chat: [],
  evidence: [],
  tasks,
  sandboxId: "sb1",
  previewReady: true,
  spec: {
    url: "https://example.com/",
    goal: "",
    pages: [],
    flows: [],
    openQuestions: [],
    approved: true,
    revision: 1,
  },
});

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Run", () => {
  it("stops workers and the sandbox at the 2-hour limit, then refuses actions", async () => {
    mockFetch();
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    const { run, state, ready } = fakeRun(
      baseState(threeHoursAgo, "building", [task("t01", "building")]),
    );
    await ready;
    await run.alarm();
    expect(calls).toContain("POST https://daytona.test/sandbox/sb1/stop");
    expect(state()).toMatchObject({ phase: "stopped", expired: true });
    expect(state().tasks[0].status).toBe("stopped");
    await expect(run.message("more")).rejects.toThrow("2-hour limit");
  });

  it("keeps the next alarm within the run's deadline", async () => {
    mockFetch();
    const startedAt = new Date(Date.now() - 3600_000).toISOString();
    const { run, scheduled, ready } = fakeRun(baseState(startedAt, "done", []));
    await ready;
    await run.alarm();
    expect(scheduled()).toBe(Date.parse(startedAt) + 2 * 3600_000);
  });

  it("retries a failed sandbox shutdown without retrying sandboxes already stopped", async () => {
    let stops = 0;
    const stopped = new Set<string>();
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${input}`);
      if (input === "https://daytona.test/sandbox/sb1/stop" && ++stops === 1)
        return new Response("temporary failure", { status: 503 });
      if (input.endsWith("/stop")) stopped.add(input.slice(0, -5));
      if (/^https:\/\/daytona.test\/sandbox\/[^/]+$/.test(input))
        return Response.json({
          state: stopped.has(input) ? "stopped" : "started",
        });
      if (input.endsWith("/toolbox-proxy-url"))
        return Response.json({ url: "https://toolbox.test" });
      return Response.json({ exitCode: 0, result: "" });
    });
    const { run, state, ready, scheduled } = fakeRun({
      ...baseState(
        new Date(Date.now() - 3 * 3600_000).toISOString(),
        "done",
        [],
      ),
      variants: [{ sandboxId: "sb2" }],
    });
    await ready;
    await run.alarm();
    expect(state()).toMatchObject({
      expired: true,
      phase: "stopped",
      stoppingSandboxIds: ["sb1"],
    });
    expect(scheduled()).toBeGreaterThan(Date.now());
    await expect(run.message("more")).rejects.toThrow("2-hour limit");
    await run.alarm();
    expect(state().stoppingSandboxIds).toEqual([]);
    expect(stops).toBe(2);
    expect(
      calls.filter((c) => c === "POST https://daytona.test/sandbox/sb2/stop"),
    ).toHaveLength(1);
  });

  it("promotes a copy, accepts the next brief and reuses its sandbox for the next build", async () => {
    const uploads: { path: string; text: string }[] = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${input}`);
      if (input.endsWith("/toolbox-proxy-url"))
        return Response.json({ url: "https://toolbox.test" });
      if (input.includes("/files/upload")) {
        const file = (init.body as FormData).get("file") as Blob;
        uploads.push({
          path: new URL(input).searchParams.get("path")!,
          text: await file.text(),
        });
      }
      if (input === "https://api.openai.com/v1/responses") {
        const name = JSON.parse(init.body as string).text.format.name;
        return Response.json({
          output_text: JSON.stringify(
            name === "orchestrator_turn"
              ? {
                  reply: "Follow-up approved",
                  spec: { pages: [], flows: [], openQuestions: [] },
                  userApproved: true,
                }
              : name === "plan"
                ? { tasks: [task("next", "queued")] }
                : { pass: true, summary: "Plan accepted", findings: [] },
          ),
        });
      }
      return Response.json({ exitCode: 0, result: "" });
    });
    const { run, state, ready } = fakeRun({
      ...baseState(new Date().toISOString(), "done", [
        verifiedVariantTask("v1"),
      ]),
      variants: [
        {
          id: "v1",
          title: "Alternative",
          pod: "copy",
          sandboxId: "sb1",
          dir: "/home/daytona/variants/v1",
          status: "ready",
          snapshot: "abc",
        },
      ],
    });
    await ready;
    await run.promote("v1");
    expect(state()).toMatchObject({
      phase: "brief",
      promoted: "v1",
      sandboxId: "sb1",
      spec: { approved: false },
    });
    await run.message("Add a footer. I approve the follow-up.");
    expect(state().phase).toBe("inspecting");
    await run.alarm();
    expect(state().phase).toBe("planned");
    await run.startBuild();
    await run.alarm();
    expect(state()).toMatchObject({ phase: "building", sandboxId: "sb1" });
    expect(state().pending).toBeUndefined();
    expect(calls).not.toContain("POST https://daytona.test/sandbox");
    expect(
      JSON.parse(
        uploads.find((u) => u.path.endsWith("/spec.json"))?.text ?? "null",
      ),
    ).toMatchObject({ approved: true, revision: 2 });
  });

  it("preserves the promoted sandbox if follow-up preparation fails", async () => {
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${input}`);
      if (input.endsWith("/toolbox-proxy-url"))
        return Response.json({ url: "https://toolbox.test" });
      return new Response("temporary failure", { status: 503 });
    });
    const { run, state, ready } = fakeRun({
      ...baseState(new Date().toISOString(), "building", []),
      promoted: "v1",
      pending: "build_setup",
    });
    await ready;
    await run.alarm();
    expect(state()).toMatchObject({ phase: "planned", sandboxId: "sb1" });
    expect(calls).not.toContain("DELETE https://daytona.test/sandbox/sb1");
  });

  it("refuses a partial variant proposal before creating any pods, allowing a retry", async () => {
    mockFetch({
      variants: [{ title: "Only one", change: "", explanation: "" }],
    });
    const { run, state, ready } = fakeRun({
      ...baseState(new Date().toISOString(), "variants", []),
      pending: "variants",
    });
    await ready;
    await run.alarm();
    expect(state()).toMatchObject({ phase: "done" });
    expect(state().variants).toBeUndefined();
    expect(calls.some((c) => c.includes("/fork"))).toBe(false);
    await expect(run.makeVariants()).resolves.toMatchObject({
      phase: "variants",
    });
  });

  it("opens a fix task when the verifier fails a merged task, without rolling back", async () => {
    mockFetch({
      pass: false,
      summary: "Hero is off",
      findings: [
        { item: "t02", evidence: ["ev_001"], problem: "wrong colour" },
      ],
    });
    const { run, state, ready } = fakeRun(
      baseState(new Date().toISOString(), "done", [task("t02", "in_review")]),
    );
    await ready;
    await (run as unknown as { merge(t: Task): Promise<void> }).merge(
      state().tasks[0],
    );
    const [merged, fix] = state().tasks;
    expect(merged.status).toBe("merged");
    expect(fix).toMatchObject({
      id: "t02-fix",
      status: "queued",
      dependsOn: ["t02"],
      acceptance: ["t02: wrong colour"],
      owns: ["sections/hero.html"],
      fixFor: "t02",
    });
    expect(state().phase).toBe("building");
  });

  it("removes a fork whose preview fails and falls back to a copy, keeping forks enabled", async () => {
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${input}`);
      if (input === "https://daytona.test/sandbox/sb1/fork")
        return Response.json({ id: "sb2" });
      if (input === "https://daytona.test/sandbox/sb2")
        return Response.json({ id: "sb2", state: "started" });
      if (input.endsWith("/toolbox-proxy-url"))
        return Response.json({ url: "https://toolbox.test" });
      if (input.startsWith("https://toolbox.test/sb2/process/session/"))
        return new Response("no session", { status: 500 });
      if (input.endsWith("/process/execute"))
        return Response.json({ exitCode: 0, result: "" });
      if (input.endsWith("/preview-url"))
        return Response.json({ url: "https://3001-sb1.daytona.test" });
      return Response.json({});
    });
    const { run, state, ready } = fakeRun(
      baseState(new Date().toISOString(), "variants", []),
    );
    await ready;
    const pod = await (
      run as unknown as {
        startPod(
          id: string,
          n: number,
        ): Promise<{ pod: string; sandboxId: string }>;
      }
    ).startPod("v1", 1);
    expect(calls).toContain("DELETE https://daytona.test/sandbox/sb2");
    expect(pod).toMatchObject({ pod: "copy", sandboxId: "sb1" });
    expect(state().forkUnavailable).toBeFalsy();
  });

  it("retains the original sandbox after a failed promotion stop and retries it at expiry", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    let fail = true;
    const stopped = new Set<string>();
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${input}`);
      if (input.endsWith("/stop")) {
        if (fail) return new Response("unavailable", { status: 503 });
        stopped.add(input.slice(0, -5));
      }
      if (/^https:\/\/daytona.test\/sandbox\/[^/]+$/.test(input))
        return Response.json({
          state: stopped.has(input) ? "stopped" : "started",
        });
      if (input.endsWith("/toolbox-proxy-url"))
        return Response.json({ url: "https://toolbox.test" });
      return Response.json({ exitCode: 0, result: "" });
    });
    const { run, state, ready } = fakeRun({
      ...baseState(
        new Date(started).toISOString(),
        "done",
        ["v1", "v2", "v3"].map(verifiedVariantTask),
      ),
      variants: [variant("v1"), variant("v2"), variant("v3")],
    });
    await ready;
    await expect(run.promote("v1")).rejects.toThrow("503");
    expect(state().sandboxId).toBe("sb1");
    expect(state().promoted).toBeUndefined();
    fail = false;
    vi.setSystemTime(started + 3 * 3600_000);
    await run.alarm();
    expect(state().stoppingSandboxIds).toEqual([]);
    expect(
      calls.filter((c) => c === "POST https://daytona.test/sandbox/sb1/stop"),
    ).toHaveLength(2);
    expect(stopped.size).toBe(4);
  });

  it.each(["fork", "copy"] as const)(
    "serializes %s promotion before its first external await",
    async (pod) => {
      const entered = deferred();
      const release = deferred();
      const stopped = new Set<string>();
      vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
        calls.push(`${init.method ?? "GET"} ${input}`);
        if (
          (pod === "fork" && input === "https://daytona.test/sandbox/sb1") ||
          (pod === "copy" && input.endsWith("/process/execute"))
        ) {
          entered.resolve();
          await release.promise;
        }
        if (input.endsWith("/stop")) stopped.add(input.slice(0, -5));
        if (/^https:\/\/daytona.test\/sandbox\/[^/]+$/.test(input))
          return Response.json({
            state: stopped.has(input) ? "stopped" : "started",
          });
        if (input.endsWith("/toolbox-proxy-url"))
          return Response.json({ url: "https://toolbox.test" });
        return Response.json({ exitCode: 0, result: "" });
      });
      const { run, state, ready } = fakeRun({
        ...baseState(
          new Date().toISOString(),
          "done",
          ["v1", "v2"].map(verifiedVariantTask),
        ),
        variants: [variant("v1", pod), variant("v2", pod)],
      });
      await ready;
      const first = run.promote("v1");
      await entered.promise;
      expect(state().sandboxId).toBe("sb1");
      await expect(run.promote("v2")).rejects.toThrow("already in progress");
      release.resolve();
      await first;
      expect(state()).toMatchObject({
        promoted: "v1",
        phase: "brief",
        sandboxId: pod === "fork" ? "sb2" : "sb1",
      });
      expect(calls).not.toContain("POST https://daytona.test/sandbox/sb2/stop");
    },
  );

  it.each([undefined, "v1"])(
    "verifies a variant task despite preview refresh failure (fixFor: %s)",
    async (fixFor) => {
      const requests: string[] = [];
      vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
        if (input.endsWith("/toolbox-proxy-url"))
          return Response.json({ url: "https://toolbox.test" });
        if (input.includes("/signed-preview-url"))
          return new Response("unavailable", { status: 503 });
        if (input === "https://api.openai.com/v1/responses") {
          requests.push(JSON.parse(init.body as string).text.format.name);
          return Response.json({
            output_text: JSON.stringify({
              pass: false,
              summary: "Needs work",
              findings: [],
            }),
          });
        }
        return Response.json({ exitCode: 0, result: "" });
      });
      const t = {
        ...task(fixFor ? "v1-fix" : "v1", "in_review"),
        variant: "v1",
        fixFor,
      };
      const { run, state, ready } = fakeRun({
        ...baseState(new Date().toISOString(), "done", [t]),
        variants: [{ ...variant("v1"), status: "building" }],
      });
      await ready;
      await run.override(t.id, "approve", "Accept the merge");
      expect(requests).toEqual(["verify_task"]);
      expect(state().tasks[0].status).toBe("merged");
      expect(state().tasks).toHaveLength(fixFor ? 1 : 2);
      expect(
        (await run.events(0)).filter((e) => e.type === "verification"),
      ).toMatchObject([
        { data: { target: "task", taskId: t.id, pass: false } },
      ]);
    },
  );

  it.each(["task", "spec", "variant", "plan"] as const)(
    "snapshots queued %s records before later mutations",
    async (type) => {
      const release = deferred();
      const recorded: RunRecord[] = [];
      const { run, ready, flush } = fakeRun(
        baseState(new Date().toISOString(), "done", []),
        {
          RECORDS: {
            async record(input) {
              await release.promise;
              recorded.push(structuredClone(input));
            },
          },
        },
      );
      await ready;
      const emitting = run as unknown as {
        emit(type: RunEvent["type"], data: unknown): Promise<void>;
      };
      await emitting.emit("phase", { phase: "building" });
      const data = { status: "building", nested: { values: ["original"] } };
      await emitting.emit(type, data);
      data.status = "merged";
      data.nested.values.push("later");
      release.resolve();
      await flush();
      expect(recorded.map((r) => r.event.type)).toEqual(["phase", type]);
      expect(recorded[1]?.event.data).toEqual({
        status: "building",
        nested: { values: ["original"] },
      });
      expect((await run.events(0))[1]?.data).toEqual(recorded[1]?.event.data);
    },
  );

  it.each(["fork_start", "fork_failure", "fork_preview", "copy_clone"])(
    "expires without more allocations after %s crosses the deadline",
    async (boundary) => {
      vi.useFakeTimers();
      const started = Date.now();
      const expire = () => vi.setSystemTime(started + 2 * 3600_000 + 1);
      const stopped = new Set<string>();
      vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
        calls.push(`${init.method ?? "GET"} ${input}`);
        if (input === "https://api.openai.com/v1/responses")
          return Response.json({
            output_text: JSON.stringify({
              variants: [1, 2, 3].map((n) => ({
                title: `Variant ${n}`,
                change: "Layout",
                explanation: "Different layout",
              })),
            }),
          });
        if (input.endsWith("/fork")) {
          if (boundary === "fork_failure") {
            expire();
            return new Response("unavailable", { status: 503 });
          }
          return Response.json({ id: "sb2" });
        }
        if (input.endsWith("/stop")) stopped.add(input.slice(0, -5));
        if (/^https:\/\/daytona.test\/sandbox\/[^/]+$/.test(input)) {
          if (boundary === "fork_start" && input.endsWith("sb2")) expire();
          return Response.json({
            id: input.split("/").pop(),
            state: stopped.has(input) ? "stopped" : "started",
          });
        }
        if (input.endsWith("/toolbox-proxy-url"))
          return Response.json({ url: "https://toolbox.test" });
        if (input.endsWith("/process/execute")) {
          if (
            boundary === "copy_clone" &&
            JSON.parse(init.body as string).command.includes("git clone")
          )
            expire();
          return Response.json({ exitCode: 0, result: "abc" });
        }
        if (
          boundary === "fork_preview" &&
          input.endsWith("/process/session/preview/exec")
        )
          expire();
        if (input.includes("/signed-preview-url")) {
          return Response.json({ url: "https://3000-sb2.daytona.test" });
        }
        return Response.json({});
      });
      const { run, state, ready } = fakeRun({
        ...baseState(new Date(started).toISOString(), "variants", []),
        pending: "variants",
        forkUnavailable: boundary === "copy_clone",
      });
      await ready;
      await run.alarm();
      expect(state()).toMatchObject({
        phase: "stopped",
        expired: true,
        stoppingSandboxIds: [],
      });
      expect(calls.filter((c) => c.endsWith("/fork"))).toHaveLength(
        boundary === "copy_clone" ? 0 : 1,
      );
      expect(calls).toContain("POST https://daytona.test/sandbox/sb1/stop");
      expect(calls.some((c) => c.includes("/session/preview-v"))).toBe(false);
      if (boundary === "fork_start")
        expect(calls).toContain("DELETE https://daytona.test/sandbox/sb2");
      if (boundary === "fork_preview")
        expect(calls).toContain("DELETE https://daytona.test/sandbox/sb2");
    },
  );

  it.each(["review", "worker_setup"])(
    "does not dispatch a worker after %s crosses the deadline",
    async (boundary) => {
      vi.useFakeTimers();
      const started = Date.now();
      let stopped = false;
      vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
        calls.push(`${init.method ?? "GET"} ${input}`);
        if (input.endsWith("/stop")) stopped = true;
        if (input === "https://daytona.test/sandbox/sb1")
          return Response.json({ state: stopped ? "stopped" : "started" });
        if (input.endsWith("/toolbox-proxy-url"))
          return Response.json({ url: "https://toolbox.test" });
        if (input.endsWith("/process/execute")) {
          const command = JSON.parse(init.body as string).command as string;
          if (
            (boundary === "review" && command.includes("--name-only")) ||
            (boundary === "worker_setup" &&
              command.includes("git worktree add"))
          )
            vi.setSystemTime(started + 2 * 3600_000 + 1);
          return Response.json({
            exitCode: 0,
            result: command.includes(".exit") ? "1" : "",
          });
        }
        return Response.json({});
      });
      const { run, state, ready } = fakeRun(
        baseState(new Date(started).toISOString(), "building", [
          task("t1", boundary === "review" ? "building" : "queued"),
        ]),
      );
      await ready;
      await run.alarm();
      expect(state()).toMatchObject({ phase: "stopped", expired: true });
      expect(state().tasks[0].status).toBe("stopped");
      expect(calls.some((c) => c.includes("/process/session"))).toBe(false);
    },
  );

  it("cleans up a main sandbox that finishes starting after the deadline", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    let stopped = false;
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${input}`);
      if (input === "https://daytona.test/sandbox")
        return Response.json({ id: "sb1" });
      if (input.endsWith("/stop")) stopped = true;
      if (input === "https://daytona.test/sandbox/sb1") {
        vi.setSystemTime(started + 2 * 3600_000 + 1);
        return Response.json({
          id: "sb1",
          state: stopped ? "stopped" : "started",
        });
      }
      if (input.endsWith("/toolbox-proxy-url"))
        return Response.json({ url: "https://toolbox.test" });
      return Response.json({ exitCode: 0, result: "" });
    });
    const { run, state, ready } = fakeRun({
      ...baseState(new Date(started).toISOString(), "building", []),
      sandboxId: undefined,
      pending: "build_setup",
    });
    await ready;
    await run.alarm();
    expect(state()).toMatchObject({
      phase: "stopped",
      expired: true,
      stoppingSandboxIds: [],
    });
    expect(calls).toContain("DELETE https://daytona.test/sandbox/sb1");
    expect(calls.some((c) => c.includes("/process/session"))).toBe(false);
  });

  it.each(["pass", "fix_pass", "fix_verification_fail", "fix_review_fail"])(
    "derives variant promotion from required verification and fixes: %s",
    async (outcome) => {
      const t = { ...task("v1", "in_review"), variant: "v1" };
      const { run, state, ready } = fakeRun({
        ...baseState(new Date().toISOString(), "variants", [t]),
        variants: [{ ...variant("v1", "copy"), status: "building" }],
      });
      await ready;
      mockFetch({
        pass: outcome === "pass",
        summary: "Task checked",
        findings: [],
      });
      await run.override("v1", "approve", "Accept the merge");
      expect(state().tasks[0].verification).toBe(outcome === "pass");
      if (outcome !== "pass") {
        expect(state().variants[0].status).toBe("building");
        const fix = state().tasks[1];
        expect(fix).toMatchObject({ fixFor: "v1", status: "queued" });
        if (outcome === "fix_review_fail") {
          fix.status = "building";
          fix.attempts = 2;
          vi.stubGlobal("fetch", async (input: string) => {
            if (input.endsWith("/toolbox-proxy-url"))
              return Response.json({ url: "https://toolbox.test" });
            return Response.json({ exitCode: 0, result: "1" });
          });
        } else {
          mockFetch({
            pass: outcome === "fix_pass",
            summary: "Fix checked",
            findings: [],
          });
          await run.override(fix.id, "approve", "Accept the fix");
        }
      }
      await run.alarm();
      const passes = outcome === "pass" || outcome === "fix_pass";
      expect(state().phase).toBe("done");
      expect(state().variants[0].status).toBe(passes ? "ready" : "failed");
      if (passes) {
        await expect(run.promote("v1")).resolves.toMatchObject({
          promoted: "v1",
          phase: "brief",
        });
      } else {
        await expect(run.promote("v1")).rejects.toThrow("not ready");
      }
    },
  );

  it("never exposes a ready variant while its verifier is still pending", async () => {
    const entered = deferred();
    const release = deferred();
    vi.stubGlobal("fetch", async (input: string) => {
      if (input.endsWith("/toolbox-proxy-url"))
        return Response.json({ url: "https://toolbox.test" });
      if (input === "https://api.openai.com/v1/responses") {
        entered.resolve();
        await release.promise;
        return Response.json({
          output_text: JSON.stringify({
            pass: true,
            summary: "Verified",
            findings: [],
          }),
        });
      }
      return Response.json({ exitCode: 0, result: "" });
    });
    const { run, state, ready } = fakeRun({
      ...baseState(new Date().toISOString(), "variants", [
        { ...task("v1", "in_review"), variant: "v1" },
      ]),
      variants: [{ ...variant("v1"), status: "building" }],
    });
    await ready;
    const merging = run.override("v1", "approve", "Accept");
    await entered.promise;
    expect(state().variants[0].status).toBe("building");
    expect(
      (await run.events(0))
        .filter((e) => e.type === "variant")
        .every((e) => (e.data as { status: string }).status !== "ready"),
    ).toBe(true);
    release.resolve();
    await merging;
    expect(state().variants[0].status).toBe("ready");
  });

  it.each([undefined, false])(
    "refuses a stored ready variant without successful verification (%s)",
    async (verification) => {
      mockFetch();
      const { run, ready } = fakeRun({
        ...baseState(new Date().toISOString(), "done", [
          { ...verifiedVariantTask("v1"), verification },
        ]),
        variants: [variant("v1")],
      });
      await ready;
      await expect(run.promote("v1")).rejects.toThrow(
        "has not passed required verification",
      );
      expect(calls).toEqual([]);
    },
  );

  it.each(["main", "variant", "fix"])(
    "persists an explicit %s verification-request failure and permits a successful retry",
    async (kind) => {
      const t = {
        ...task(kind === "fix" ? "v1-fix" : "v1", "in_review"),
        variant: kind === "main" ? undefined : "v1",
        fixFor: kind === "fix" ? "v1" : undefined,
      };
      const tasks =
        kind === "fix"
          ? [{ ...verifiedVariantTask("v1"), verification: false }, t]
          : [t];
      const { run, state, ready } = fakeRun({
        ...baseState(
          new Date().toISOString(),
          kind === "main" ? "building" : "variants",
          tasks,
        ),
        variants:
          kind === "main"
            ? undefined
            : [{ ...variant("v1", "copy"), status: "building" }],
      });
      await ready;
      mockFetch({}, 503);
      await expect(run.override(t.id, "approve", "Accept")).rejects.toThrow(
        "503",
      );
      const failed = state().tasks.find((item: Task) => item.id === t.id);
      expect(failed).toMatchObject({
        status: "failed",
        failure: expect.stringContaining("Verification unavailable"),
        nextAction: expect.stringContaining("retry verification"),
      });
      expect(failed.verification).toBeUndefined();
      expect(state().tasks).toHaveLength(tasks.length);
      if (kind !== "main") expect(state().variants[0].status).toBe("failed");
      expect(
        (await run.events(0)).filter((e) => e.type === "verification"),
      ).toEqual([]);
      const restored = fakeRun(structuredClone(state()));
      await restored.ready;
      mockFetch({ pass: true, summary: "Verified", findings: [] });
      await restored.run.override(t.id, "approve", "Retry the check");
      expect(
        restored.state().tasks.find((item: Task) => item.id === t.id),
      ).toMatchObject({
        status: "merged",
        verification: true,
        failure: undefined,
        nextAction: undefined,
      });
      await restored.run.alarm();
      expect(restored.state().phase).toBe("done");
      if (kind !== "main")
        expect(restored.state().variants[0].status).toBe("ready");
    },
  );

  it("reopens dependent work after retrying failed verification from a completed run", async () => {
    mockFetch({ pass: true, summary: "Verified", findings: [] });
    const { run, state, ready } = fakeRun(
      baseState(new Date().toISOString(), "done", [
        { ...task("t1", "failed"), failure: "Verification unavailable" },
        { ...task("t2", "queued"), dependsOn: ["t1"] },
      ]),
    );
    await ready;
    await run.override("t1", "approve", "Retry");
    expect(state().phase).toBe("building");
    expect(state().tasks[0]).toMatchObject({
      status: "merged",
      verification: true,
    });
  });

  it("revokes readiness and reopens the variant when its review is rejected", async () => {
    const { run, state, ready } = fakeRun({
      ...baseState(new Date().toISOString(), "done", [
        verifiedVariantTask("v1"),
      ]),
      variants: [variant("v1", "copy")],
    });
    await ready;
    await run.override("v1", "reject", "Revise this task");
    expect(state().phase).toBe("variants");
    expect(state().tasks[0]).toMatchObject({
      status: "queued",
      verification: undefined,
    });
    expect(state().variants[0].status).toBe("building");
  });

  it.each(["plan", "final"])(
    "does not announce %s completion when its verification request fails",
    async (target) => {
      vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
        if (input === "https://api.openai.com/v1/responses") {
          const name = JSON.parse(init.body as string).text.format.name;
          return name === "plan"
            ? Response.json({ output_text: JSON.stringify({ tasks: [] }) })
            : Response.json({ error: "unavailable" }, { status: 503 });
        }
        return Response.json({});
      });
      const { run, state, ready } = fakeRun({
        ...baseState(
          new Date().toISOString(),
          target === "plan" ? "inspecting" : "building",
          [],
        ),
        pending: target === "plan" ? "inspect" : undefined,
      });
      await ready;
      await run.alarm();
      expect(state().phase).toBe(target === "plan" ? "failed" : "building");
      const events = await run.events(0);
      expect(
        events
          .filter((e) => e.type === "phase")
          .some((e) =>
            ["planned", "done"].includes((e.data as { phase: string }).phase),
          ),
      ).toBe(false);
      expect(events.some((e) => e.type === "error")).toBe(true);
      if (target === "plan") {
        await expect(run.startBuild()).rejects.toThrow("No build started");
      } else {
        mockFetch({ pass: true, summary: "Verified", findings: [] });
        await run.alarm();
        expect(state().phase).toBe("done");
      }
    },
  );

  it("reports best-effort record failures locally without recursively recording notices", async () => {
    mockFetch();
    let fail = true;
    const projected: RunRecord[] = [];
    const { run, ready, flush } = fakeRun(
      baseState(new Date().toISOString(), "brief", []),
      {
        RECORDS: {
          async record(input) {
            projected.push(structuredClone(input));
            if (fail) throw new Error("projection unavailable");
          },
        },
      },
    );
    await ready;
    await run.approveSpec();
    await flush();
    expect(projected).toHaveLength(2);
    const notices = (await run.events(0)).filter((e) => e.type === "error");
    expect(notices).toHaveLength(2);
    for (const input of projected)
      expect(
        notices.some((e) =>
          (e.data as { message: string }).message.includes(
            `record ${input.event.seq} was not fully persisted`,
          ),
        ),
      ).toBe(true);
    fail = false;
    await run.stop();
    await flush();
    expect(projected).toHaveLength(3);
    expect(projected.every((input) => input.event.type !== "error")).toBe(true);
    expect(projected[2]?.event.data).toEqual({ phase: "stopped" });
  });

  it("reports a partial projection failure without claiming its missing approval was saved", async () => {
    const store = new MemoryRunStore();
    vi.spyOn(store, "recordApproval").mockRejectedValueOnce(
      new Error("approval unavailable"),
    );
    const { run, ready, flush } = fakeRun(
      baseState(new Date().toISOString(), "brief", []),
      {
        RECORDS: { record: (input) => recordRunEvent(store, input) },
      },
    );
    await ready;
    await run.approveSpec();
    await flush();
    const records = store.runs.get("run-1");
    expect(records?.events.some((e) => e.state === "inspecting")).toBe(true);
    expect(records?.approvals).toEqual([]);
    expect(
      (await run.events(0)).filter((e) => e.type === "error"),
    ).toMatchObject([
      { data: { message: expect.stringContaining("approval unavailable") } },
    ]);
  });

  it("invalidates a completed fix when its parent task is reopened", async () => {
    const { run, state, ready } = fakeRun({
      ...baseState(new Date().toISOString(), "done", [
        { ...verifiedVariantTask("v1"), verification: false },
        {
          ...task("v1-fix", "merged"),
          variant: "v1",
          fixFor: "v1",
          verification: true,
        },
      ]),
      variants: [variant("v1", "copy")],
    });
    await ready;
    await run.override("v1", "reject", "Rebuild this version");
    expect(state().tasks.map((t: Task) => [t.status, t.verification])).toEqual([
      ["queued", undefined],
      ["queued", undefined],
    ]);
    expect(state().variants[0].status).toBe("building");
    mockFetch({ pass: false, summary: "Still needs work", findings: [] });
    await run.override("v1", "approve", "Review the new work");
    expect(state().variants[0].status).toBe("building");
    expect(state().tasks[1].status).toBe("queued");
  });

  it("marks a variant failed when its required fix is blocked by a failed task", async () => {
    const { run, state, ready } = fakeRun({
      ...baseState(new Date().toISOString(), "variants", [
        { ...task("v1", "failed"), variant: "v1" },
        {
          ...task("v1-fix", "queued"),
          variant: "v1",
          fixFor: "v1",
          dependsOn: ["v1"],
        },
      ]),
      variants: [{ ...variant("v1"), status: "building" }],
    });
    await ready;
    await run.alarm();
    expect(state().phase).toBe("done");
    expect(state().variants[0].status).toBe("failed");
    await expect(run.promote("v1")).rejects.toThrow("not ready");
  });

  it.each(["fork_start", "fork_preview", "main_start", "main_setup"])(
    "keeps allocated ownership and retries failed cleanup after %s",
    async (stage) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
      const main = stage.startsWith("main");
      let forks = 1;
      let orphanStops = 0;
      const stopped = new Set<string>();
      vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
        calls.push(`${init.method ?? "GET"} ${input}`);
        if (input === "https://api.openai.com/v1/responses")
          return Response.json({
            output_text: JSON.stringify({
              variants: [1, 2, 3].map((n) => ({
                title: `Variant ${n}`,
                change: "Layout",
                explanation: "Alternative layout",
              })),
            }),
          });
        if (input === "https://daytona.test/sandbox" || input.endsWith("/fork"))
          return Response.json({ id: main ? "sb2" : `sb${++forks}` });
        if (init.method === "DELETE")
          return new Response("delete unavailable", { status: 503 });
        if (input.endsWith("/stop")) {
          if (input.endsWith("/sb2/stop") && ++orphanStops === 1)
            return new Response("stop unavailable", { status: 503 });
          stopped.add(input.slice(0, -5));
        }
        if (/^https:\/\/daytona.test\/sandbox\/[^/]+$/.test(input))
          return Response.json({
            id: input.split("/").pop(),
            state: stopped.has(input)
              ? "stopped"
              : input.endsWith("sb2") && stage.endsWith("start")
                ? "error"
                : "started",
          });
        if (input.endsWith("/toolbox-proxy-url"))
          return Response.json({ url: "https://toolbox.test" });
        if (
          stage === "fork_preview" &&
          input.includes("/sb2/process/session/preview/exec")
        )
          return new Response("preview unavailable", { status: 503 });
        if (input.endsWith("/process/execute"))
          return Response.json({
            exitCode: stage === "main_setup" ? 1 : 0,
            result: "abc",
          });
        return Response.json({ cmdId: "command" });
      });
      const { run, state, persisted, ready, scheduled } = fakeRun({
        ...baseState(
          new Date().toISOString(),
          main ? "building" : "variants",
          [],
        ),
        sandboxId: main ? undefined : "sb1",
        pending: main ? "build_setup" : "variants",
      });
      await ready;
      await run.alarm();
      expect(persisted().sandboxIds).toContain("sb2");
      expect(persisted().stoppingSandboxIds).toContain("sb2");
      if (main) expect(state().sandboxId).toBeUndefined();
      else expect(state().forkUnavailable).toBeFalsy();
      const retryAt = Date.now() + (main ? 10_000 : 100);
      expect(scheduled()).toBe(retryAt);
      await run.stop();
      expect(scheduled()).toBe(retryAt);
      const restored = fakeRun(persisted(), {}, scheduled());
      await restored.ready;
      expect(restored.scheduled()).toBe(retryAt);
      vi.setSystemTime(retryAt);
      await restored.run.alarm();
      expect(restored.persisted().stoppingSandboxIds).toContain("sb2");
      expect(restored.state().expired).toBeUndefined();
      expect(restored.scheduled()).toBe(retryAt + 10_000);
      vi.setSystemTime(retryAt + 10_000);
      await restored.run.alarm();
      expect(restored.persisted().stoppingSandboxIds).toEqual([]);
      expect(orphanStops).toBe(2);
      expect(stopped.has("https://daytona.test/sandbox/sb2")).toBe(true);
    },
  );

  it("keeps shutdown retries within the deadline until the run expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
    const deadline = Date.now() + 500;
    mockFetch();
    const provider = fetch;
    let stops = 0;
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
      if (input.endsWith("/stop") && ++stops === 1)
        return Promise.resolve(new Response("unavailable", { status: 503 }));
      return provider(input, init);
    });
    const { run, ready, scheduled, persisted } = fakeRun({
      ...baseState(
        new Date(deadline - 2 * 3600_000).toISOString(),
        "stopped",
        [],
      ),
      stoppingSandboxIds: ["sb1"],
    });
    await ready;
    await run.alarm();
    expect(scheduled()).toBe(deadline);
    vi.setSystemTime(deadline);
    await run.alarm();
    expect(persisted()).toMatchObject({
      expired: true,
      stoppingSandboxIds: [],
    });
    expect(stops).toBe(2);
    expect(scheduled()).toBeNull();
  });

  it("claims Stop before awaiting worker cleanup", async () => {
    const entered = deferred();
    const release = deferred();
    vi.stubGlobal("fetch", async (input: string) => {
      if (input.endsWith("/toolbox-proxy-url"))
        return Response.json({ url: "https://toolbox.test" });
      entered.resolve();
      await release.promise;
      return Response.json({ exitCode: 0, result: "" });
    });
    const { run, state, persisted, ready } = fakeRun(
      baseState(new Date().toISOString(), "done", []),
    );
    await ready;
    const stopping = run.stop();
    await entered.promise;
    expect(state().phase).toBe("stopped");
    expect(persisted().phase).toBe("stopped");
    await expect(run.makeVariants()).rejects.toThrow("was stopped");
    release.resolve();
    await stopping;
  });

  it.each([
    "ideas",
    "main_create",
    "fork_start",
    "main_preview",
    "worker_session",
    "review",
    "plan",
    "final",
    "promotion",
  ])(
    "never resumes allocation, dispatch or completion after Stop during %s",
    async (stage) => {
      const entered = deferred();
      const release = deferred();
      let paused = false;
      vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
        calls.push(`${init.method ?? "GET"} ${input}`);
        const name =
          input === "https://api.openai.com/v1/responses"
            ? JSON.parse(init.body as string).text.format.name
            : "";
        const command = input.endsWith("/process/execute")
          ? (JSON.parse(init.body as string).command as string)
          : "";
        const shouldPause =
          stage === "ideas"
            ? name === "variants"
            : stage === "main_create"
              ? input === "https://daytona.test/sandbox"
              : stage === "fork_start"
                ? input === "https://daytona.test/sandbox/sb2"
                : ["worker_session", "main_preview"].includes(stage)
                  ? input.endsWith("/process/session")
                  : stage === "promotion"
                    ? command.includes("git fetch")
                    : name ===
                      (stage === "final"
                        ? "verify_final"
                        : stage === "plan"
                          ? "plan"
                          : "review");
        if (!paused && shouldPause) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
        if (input === "https://api.openai.com/v1/responses")
          return Response.json({
            output_text: JSON.stringify(
              name === "variants"
                ? {
                    variants: [1, 2, 3].map((n) => ({
                      title: `Variant ${n}`,
                      change: "Layout",
                      explanation: "Alternative layout",
                    })),
                  }
                : name === "plan"
                  ? { tasks: [] }
                  : name === "review"
                    ? { verdict: "approve", reason: "Accepted", findings: [] }
                    : { pass: true, summary: "Verified", findings: [] },
            ),
          });
        if (input === "https://daytona.test/sandbox" || input.endsWith("/fork"))
          return Response.json({ id: "sb2" });
        if (/^https:\/\/daytona.test\/sandbox\/[^/]+$/.test(input))
          return Response.json({
            id: input.split("/").pop(),
            state: "started",
          });
        if (input.endsWith("/toolbox-proxy-url"))
          return Response.json({ url: "https://toolbox.test" });
        if (input.endsWith("/process/execute"))
          return Response.json({
            exitCode: 0,
            result: command.includes("cat /home/daytona/logs/") ? "0" : "diff",
          });
        return Response.json({ cmdId: "command" });
      });
      const initial = baseState(
        new Date().toISOString(),
        ["ideas", "fork_start"].includes(stage)
          ? "variants"
          : stage === "promotion"
            ? "done"
            : stage === "plan"
              ? "inspecting"
              : "building",
        stage === "worker_session"
          ? [task("t1", "queued")]
          : stage === "review"
            ? [task("t1", "building")]
            : stage === "promotion"
              ? [verifiedVariantTask("v1")]
              : [],
      );
      const { run, state, ready } = fakeRun({
        ...initial,
        sandboxId: ["main_create", "main_preview"].includes(stage)
          ? undefined
          : "sb1",
        pending: ["ideas", "fork_start"].includes(stage)
          ? "variants"
          : ["main_create", "main_preview"].includes(stage)
            ? "build_setup"
            : stage === "plan"
              ? "inspect"
              : undefined,
        variants: stage === "promotion" ? [variant("v1", "copy")] : undefined,
      });
      await ready;
      const work = (
        stage === "promotion" ? run.promote("v1") : run.alarm()
      ).catch((e) => e);
      await entered.promise;
      await run.stop();
      const stopIndex = calls.length;
      release.resolve();
      await work;
      expect(state().phase).toBe("stopped");
      const later = calls.slice(stopIndex);
      expect(
        later.filter(
          (call) =>
            call === "POST https://daytona.test/sandbox" ||
            call.endsWith("/fork") ||
            /POST .*\/process\/session\/[^/]+\/exec$/.test(call),
        ),
      ).toEqual([]);
      const phases = (await run.events(0)).filter((e) => e.type === "phase");
      expect(phases.at(-1)?.data).toMatchObject({ phase: "stopped" });
      if (stage === "main_create")
        expect(calls).toContain("DELETE https://daytona.test/sandbox/sb2");
      if (stage === "worker_session" || stage === "review")
        expect(state().tasks[0].status).toBe("stopped");
    },
  );

  it.each([undefined, "v1"])(
    "persists the required fix before Agent Memory reporting fails (%s)",
    async (variantId) => {
      mockFetch({ pass: false, summary: "Needs repair", findings: [] });
      const provider = fetch;
      vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
        if (input.startsWith("https://memory.test"))
          throw new Error("memory unavailable");
        return provider(input, init);
      });
      const { run, persisted, ready } = fakeRun(
        {
          ...baseState(new Date().toISOString(), "done", [
            { ...task("t1", "in_review"), variant: variantId },
          ]),
          variants: variantId
            ? [{ ...variant("v1", "copy"), status: "building" }]
            : undefined,
        },
        { SPECTRON_URL: "https://memory.test", SPECTRON_CONTEXT_ID: "context" },
      );
      await ready;
      await expect(run.override("t1", "approve", "Accept")).rejects.toThrow(
        "memory unavailable",
      );
      const restored = fakeRun(persisted());
      await restored.ready;
      expect((await restored.run.getState()).tasks).toMatchObject([
        { id: "t1", status: "merged", verification: false },
        { id: "t1-fix", status: "queued", fixFor: "t1", variant: variantId },
      ]);
      expect((await restored.run.getState()).phase).toBe(
        variantId ? "variants" : "building",
      );
    },
  );

  it("keeps signed variant capabilities out of durable data, prompts, webhooks and traces", async () => {
    const signed = "https://private-preview.test/?token=capability-secret";
    const outbound: string[] = [];
    const records: RunRecord[] = [];
    const signedRequests: string[] = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      if (input.includes("/signed-preview-url")) {
        signedRequests.push(input);
        return Response.json({ url: signed });
      }
      if (input === signed) return new Response("<main>Preview HTML</main>");
      if (typeof init.body === "string") outbound.push(init.body);
      if (init.body instanceof FormData)
        outbound.push(await ((init.body.get("file") as Blob)?.text() ?? ""));
      if (input.endsWith("/toolbox-proxy-url"))
        return Response.json({ url: "https://toolbox.test" });
      if (input.endsWith("/process/execute"))
        return Response.json({ exitCode: 0, result: "abc" });
      if (input === "https://api.openai.com/v1/responses") {
        const name = JSON.parse(init.body as string).text.format.name;
        return Response.json({
          output_text: JSON.stringify(
            name === "variants"
              ? {
                  variants: [1, 2, 3].map((n) => ({
                    title: `Variant ${n}`,
                    change: "Layout",
                    explanation: "Alternative layout",
                  })),
                }
              : name === "orchestrator_turn"
                ? {
                    reply: "Follow up",
                    spec: { pages: [], flows: [], openQuestions: [] },
                    userApproved: true,
                  }
                : name === "plan"
                  ? { tasks: [] }
                  : { pass: true, summary: "Verified", findings: [] },
          ),
        });
      }
      return Response.json({ cmdId: "command" });
    });
    const { run, persisted, flush, ready } = fakeRun(
      {
        ...baseState(new Date().toISOString(), "variants", []),
        pending: "variants",
        forkUnavailable: true,
      },
      {
        RECORDS: {
          async record(input) {
            records.push(structuredClone(input));
          },
        },
        EVENTS_WEBHOOK_URL: "https://webhook.test",
        ARIZE_API_KEY: "test",
        ARIZE_SPACE_ID: "test",
      },
    );
    await ready;
    await run.alarm();
    expect(signedRequests).toEqual([]);
    for (const id of ["v1", "v2", "v3"])
      await run.override(id, "approve", "Accept");
    await run.alarm();
    expect(await run.previewLink(undefined, "v1")).toBe(signed);
    expect(signedRequests.at(-1)).toContain("/ports/3001/");
    await run.promote("v1");
    await run.message("Approve a follow-up");
    await run.alarm();
    await flush();
    const serialized = JSON.stringify({
      state: persisted(),
      events: await run.events(0),
      records,
      outbound,
    });
    expect(serialized).not.toContain(signed);
    expect(serialized).not.toContain("capability-secret");
    expect(
      persisted().variants.every((v: object) => !("previewUrl" in v)),
    ).toBe(true);
  });

  it.each([
    ["plan", "verifier"],
    ["plan", "report"],
    ["plan", "report_error"],
    ["final", "report"],
    ["task", "report"],
    ["promotion", "report"],
  ])("keeps Stop terminal during %s %s", async (target, delay) => {
    const entered = deferred();
    const release = deferred();
    mockFetch({ pass: false, summary: "Needs repair", findings: [] });
    const provider = fetch;
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      const report =
        target === "promotion"
          ? "Promoted variant"
          : `Verifier on ${target === "task" ? "t1" : target}`;
      if (
        (delay === "verifier" && body.text?.format?.name === "verify_plan") ||
        (delay.startsWith("report") &&
          input.endsWith("/facts") &&
          body.text?.startsWith(report))
      ) {
        entered.resolve();
        await release.promise;
        if (delay === "report_error") throw new Error("memory unavailable");
      }
      if (body.text?.format?.name === "plan")
        return Response.json({ output_text: JSON.stringify({ tasks: [] }) });
      return provider(input, init);
    });
    const { run, persisted, ready } = fakeRun(
      {
        ...baseState(
          new Date().toISOString(),
          target === "plan"
            ? "inspecting"
            : target === "promotion"
              ? "done"
              : "building",
          target === "task"
            ? [task("t1", "in_review")]
            : target === "promotion"
              ? [verifiedVariantTask("v1")]
              : [],
        ),
        pending: target === "plan" ? "inspect" : undefined,
        variants: target === "promotion" ? [variant("v1", "copy")] : undefined,
      },
      { SPECTRON_URL: "https://memory.test", SPECTRON_CONTEXT_ID: "context" },
    );
    await ready;
    const work = (
      target === "task"
        ? run.override("t1", "approve", "Accept")
        : target === "promotion"
          ? run.promote("v1")
          : run.alarm()
    ).catch((e) => e);
    await entered.promise;
    await run.stop();
    const stoppedSeq = (await run.events(0)).at(-1)!.seq;
    release.resolve();
    await work;
    expect(persisted().phase).toBe("stopped");
    expect(
      (await run.events(stoppedSeq)).filter(
        (e) => e.type === "phase" || e.type === "chat",
      ),
    ).toEqual([]);
    await expect(run.startBuild()).rejects.toThrow("was stopped");
    expect(calls).not.toContain("POST https://daytona.test/sandbox");
  });

  it.each([
    [undefined, "2026-10-16T10:30:00.000Z", "2026-10-16T10:30:00.000Z"],
    ["invalid", "2026-10-16T10:30:00-01:00", "2026-10-16T10:30:00-01:00"],
    [
      "2026-10-16T11:00:00.000Z",
      "2026-10-16T11:30:00.000Z",
      "2026-10-16T11:00:00.000Z",
    ],
  ])(
    "migrates stored start %s and first chat %s without extending the run",
    async (startedAt, ts, expected) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
      mockFetch();
      const store = new MemoryRunStore();
      const records: RunRecord[] = [];
      const initial = {
        ...baseState("", "done", []),
        startedAt,
        chat: [{ role: "user", text: "Original request", ts }],
      };
      const { run, persisted, ready, flush, scheduled } = fakeRun(initial, {
        RECORDS: {
          async record(input) {
            records.push(input);
            await recordRunEvent(store, input);
          },
        },
      });
      await ready;
      expect(persisted().startedAt).toBe(expected);
      expect(scheduled()).toBe(Date.parse(expected!) + 2 * 3600_000);
      await run.stop();
      await flush();
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((r) => r.run.startedAt === expected)).toBe(true);
      expect((await store.getRun("run-1"))?.createdAt).toBe(expected);
      const earlier = Date.now() + 1000;
      const restored = fakeRun(persisted(), {}, earlier);
      await restored.ready;
      expect(restored.scheduled()).toBe(earlier);
    },
  );

  it("arms immediate cleanup for a legacy run already past its original deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
    mockFetch();
    const ts = "2026-10-16T09:00:00.000Z";
    const { run, persisted, ready, scheduled } = fakeRun({
      ...baseState("", "done", []),
      startedAt: undefined,
      chat: [{ role: "user", text: "Original request", ts }],
    });
    await ready;
    expect(persisted().startedAt).toBe(ts);
    expect(scheduled()).toBe(Date.now());
    await expect(run.makeVariants()).rejects.toThrow("2-hour limit");
    await run.alarm();
    expect(persisted()).toMatchObject({
      phase: "stopped",
      expired: true,
      startedAt: ts,
    });
    expect(calls).toContain("POST https://daytona.test/sandbox/sb1/stop");
    expect(scheduled()).toBeNull();
  });

  it.each([
    undefined,
    "invalid",
    "2026-02-30T12:00:00Z",
    "2026-10-16T24:00:00Z",
    "2026-10-16T12:00:00+99:00",
  ])(
    "stops legacy runs with unusable history %s without fabricating records",
    async (ts) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
      mockFetch();
      const record = vi.fn();
      const { run, persisted, ready, flush, scheduled } = fakeRun(
        {
          ...baseState("", "done", []),
          startedAt: ts,
          chat: ts ? [{ role: "user", text: "Original request", ts }] : [],
        },
        { RECORDS: { record } },
      );
      await ready;
      expect(persisted()).toMatchObject({ phase: "stopped", expired: true });
      expect(persisted().startedAt).toBeUndefined();
      expect(persisted().error).toContain("no valid stored start time");
      expect(
        (await run.events(0)).filter((e) => e.type === "error"),
      ).toHaveLength(1);
      expect(scheduled()).toBe(Date.now());
      await expect(run.startBuild()).rejects.toThrow(
        "no valid stored start time",
      );
      await run.alarm();
      await flush();
      expect(calls).toContain("POST https://daytona.test/sandbox/sb1/stop");
      expect(record).not.toHaveBeenCalled();
      expect(scheduled()).toBeNull();
      const restored = fakeRun(persisted(), { RECORDS: { record } });
      await restored.ready;
      expect(restored.persisted().startedAt).toBeUndefined();
      expect(restored.scheduled()).toBeNull();
    },
  );

  it("preserves existing preview availability while dropping legacy capability fields from saved state", async () => {
    const legacy = "https://legacy-preview.test/?token=old-capability";
    vi.stubGlobal("fetch", async () =>
      Response.json({ url: "https://fresh-preview.test/" }),
    );
    const { run, persisted, ready } = fakeRun({
      ...baseState(new Date().toISOString(), "done", [
        verifiedVariantTask("v1"),
      ]),
      previewReady: undefined,
      previewUrl: legacy,
      variants: [{ ...variant("v1", "copy"), previewUrl: legacy }],
    });
    await ready;
    expect(JSON.stringify(persisted())).not.toContain(legacy);
    expect(await run.previewLink()).toBe("https://fresh-preview.test/");
    expect(await run.previewLink(undefined, "v1")).toBe(
      "https://fresh-preview.test/",
    );
  });
});
