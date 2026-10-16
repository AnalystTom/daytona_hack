import { afterEach, describe, expect, it, vi } from "vitest";
import { Run } from "../src/run";
import type { Env, RunEvent, RunRecord, Task } from "../src/types";

// A Durable Object state in memory; Daytona and OpenAI are answered by a mocked fetch.
function fakeRun(state: object, overrides: Partial<Env> = {}) {
  const pending: Promise<unknown>[] = [];
  const data = new Map<string, unknown>([["state", state]]);
  const alarms: number[] = [];
  let ready: Promise<unknown> = Promise.resolve();
  const ctx = {
    storage: {
      get: async (key: string) => data.get(key),
      list: async ({ prefix }: { prefix: string }) =>
        new Map([...data].filter(([key]) => key.startsWith(prefix))),
      put: async (key: string, value: unknown) => void data.set(key, value),
      setAlarm: async (at: number) => void alarms.push(at),
    },
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
  return {
    run,
    alarms,
    state: () => data.get("state") as any,
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
  previewUrl: `https://3000-${id}.daytona.test`,
  status: "ready",
  snapshot: "abc",
});

const calls: string[] = [];
function mockFetch(verdict?: object) {
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
      return Response.json({ output_text: JSON.stringify(verdict) });
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

const baseState = (startedAt: string, phase: string, tasks: Task[]) => ({
  id: "run-1",
  startedAt,
  phase,
  chat: [],
  evidence: [],
  tasks,
  sandboxId: "sb1",
  previewUrl: "https://3000-sb1.daytona.test",
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
    const { run, alarms, ready } = fakeRun(baseState(startedAt, "done", []));
    await ready;
    await run.alarm();
    expect(alarms).toEqual([Date.parse(startedAt) + 2 * 3600_000]);
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
    const { run, state, ready, alarms } = fakeRun({
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
    expect(alarms[0]).toBeGreaterThan(Date.now());
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
      ...baseState(new Date().toISOString(), "done", []),
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
      ...baseState(new Date(started).toISOString(), "done", []),
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
        ...baseState(new Date().toISOString(), "done", []),
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
        if (input.includes("/signed-preview-url")) {
          if (boundary === "fork_preview") expire();
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
        expect(calls).toContain("POST https://daytona.test/sandbox/sb2/stop");
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

  it("tracks and stops a main sandbox that finishes starting after the deadline", async () => {
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
    expect(calls).toContain("POST https://daytona.test/sandbox/sb1/stop");
    expect(calls.some((c) => c.includes("/process/session"))).toBe(false);
  });
});
