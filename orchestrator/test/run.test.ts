import { afterEach, describe, expect, it, vi } from "vitest";
import { Run } from "../src/run";
import type { Env, Task } from "../src/types";

// A Durable Object state in memory; Daytona and OpenAI are answered by a mocked fetch.
function fakeRun(state: object) {
  const data = new Map<string, unknown>([["state", state]]);
  const alarms: number[] = [];
  let ready: Promise<unknown> = Promise.resolve();
  const ctx = {
    storage: {
      get: async (key: string) => data.get(key),
      put: async (key: string, value: unknown) => void data.set(key, value),
      setAlarm: async (at: number) => void alarms.push(at),
    },
    waitUntil: () => {},
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      ready = fn();
    },
  };
  const env = {
    DAYTONA_API_URL: "https://daytona.test",
    OPENAI_API_KEY: "test",
    ORCHESTRATOR_MODEL: "gpt-test",
    VERIFIER_MODEL: "gpt-test",
  } as Env;
  const run = new Run(ctx as never, env);
  return { run, alarms, state: () => data.get("state") as any, ready };
}

const calls: string[] = [];
function mockFetch(verdict?: object) {
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? "GET"} ${input}`);
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
});
