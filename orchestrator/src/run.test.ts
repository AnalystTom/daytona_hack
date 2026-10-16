import { afterEach, describe, expect, it, vi } from "vitest";
import { Daytona } from "./daytona";
import { Run } from "./run";
import { tracing } from "./services";
import type { Env, Phase, Task } from "./types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: DurableObjectState,
      public env: Env,
    ) {}
  },
}));

const task = (status: Task["status"]): Task => ({
  id: "t01",
  title: "Hero",
  brief: "Build hero",
  outOfScope: "",
  acceptance: [],
  evidence: [],
  owns: ["index.html"],
  dependsOn: [],
  status,
  attempts: 1,
  branch: "task/t01",
});

async function setup(
  options: {
    phase?: Phase;
    pending?: "inspect" | "build_setup";
    tasks?: Task[];
    minutes?: string;
    empty?: boolean;
  } = {},
) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  const state = {
    id: "r1",
    startedAt: Date.now(),
    phase: options.phase ?? "brief",
    pending: options.pending,
    spec: {
      url: "https://example.com/",
      goal: "Rebuild",
      pages: [{ path: "/", confirmed: true }],
      flows: [],
      openQuestions: [],
      approved: true,
      revision: 1,
    },
    chat: [],
    evidence: [],
    tasks: options.tasks ?? [],
    ...(options.phase === "building"
      ? { sandboxId: "sb1", previewUrl: "https://preview.test/" }
      : {}),
  };
  const data = new Map<string, unknown>(
    options.empty ? [] : [["state", state]],
  );
  let ready!: Promise<unknown>;
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    },
    list: async () => new Map([...data].filter(([k]) => k.startsWith("ev:"))),
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: vi.fn(async () => {}),
  };
  const ctx = {
    storage,
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      ready = fn();
    },
    waitUntil: () => {},
  };
  const env = {
    RUN_MAX_MINUTES: options.minutes,
    ORCHESTRATOR_MODEL: "test",
    WORKER_MODEL: "test",
  } as Env;
  const run = new Run(ctx as unknown as DurableObjectState, env);
  await ready;
  const calls: string[] = [];
  const expire = () => vi.setSystemTime(Date.now() + 121 * 60_000);
  const request = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.openai.com")) {
        const body = JSON.parse(String(init?.body));
        const name = body.text.format.name;
        calls.push(name);
        const output =
          name === "orchestrator_turn"
            ? { reply: "Which pages?", spec: state.spec, userApproved: false }
            : name === "plan"
              ? { tasks: [] }
              : { pass: true, findings: [], summary: "Pass" };
        return Response.json({ output_text: JSON.stringify(output) });
      }
      return new Response("<html>Observed page</html>");
    },
  );
  vi.stubGlobal("fetch", request);
  vi.spyOn(Daytona.prototype, "exec").mockResolvedValue({
    exitCode: 0,
    result: "",
  });
  vi.spyOn(Daytona.prototype, "must").mockResolvedValue("");
  const startWorker = vi
    .spyOn(Daytona.prototype, "startAsync")
    .mockResolvedValue("cmd1");
  vi.spyOn(Daytona.prototype, "writeFile").mockResolvedValue(undefined);
  vi.spyOn(Daytona.prototype, "create").mockResolvedValue({ id: "sb1" });
  vi.spyOn(Daytona.prototype, "remove").mockResolvedValue(undefined);
  vi.spyOn(Daytona.prototype, "previewUrl").mockResolvedValue(
    "https://preview.test/",
  );
  vi.spyOn(Daytona.prototype, "signedPreviewUrl").mockResolvedValue(
    "https://preview.test/",
  );
  return {
    run,
    state,
    storage,
    data,
    env,
    request,
    calls,
    expire,
    startWorker,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  tracing.current = undefined;
});

describe("run paid-work deadlines", () => {
  it.each([undefined, "1"])(
    "stops expired chat, approval, build and overrides (%s minutes)",
    async (minutes) => {
      for (const action of [
        "message",
        "approve",
        "build",
        "override",
      ] as const) {
        const { run, storage, calls, startWorker } = await setup({
          phase: action === "build" ? "planned" : "brief",
          tasks: [task("failed")],
          minutes,
        });
        vi.setSystemTime(Date.now() + (minutes ? 1 : 120) * 60_000);
        const result =
          action === "message"
            ? run.message("hello")
            : action === "approve"
              ? run.approveSpec()
              : action === "build"
                ? run.startBuild()
                : run.override("t01", "approve", "yes");
        await expect(result).rejects.toThrow(/limit/);
        expect((await run.getState()).phase).toBe("stopped");
        expect(storage.deleteAlarm).toHaveBeenCalled();
        expect(calls).toEqual([]);
        expect(startWorker).not.toHaveBeenCalled();
      }
    },
  );

  it("does not capture or converse when admission was already expired", async () => {
    const { run, request } = await setup({ empty: true });
    await expect(
      run.start(
        "late",
        "https://example.com",
        "rebuild",
        Date.now() - 121 * 60_000,
      ),
    ).rejects.toThrow(/limit/);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not converse after first capture crosses the deadline", async () => {
    const { run, request, calls, expire } = await setup({ empty: true });
    request.mockImplementationOnce(async () => {
      expire();
      return new Response("<html>observed</html>");
    });
    await expect(
      run.start("r1", "https://example.com", "rebuild"),
    ).rejects.toThrow(/limit/);
    expect(calls).toEqual([]);
    expect((await run.getState()).phase).toBe("stopped");
  });

  it("does not plan after page inspection crosses the deadline", async () => {
    const { run, request, calls, expire } = await setup({
      phase: "inspecting",
      pending: "inspect",
    });
    request.mockImplementationOnce(async () => {
      expire();
      return new Response("<html>observed</html>");
    });
    await run.alarm();
    expect(calls).toEqual([]);
    expect((await run.getState()).phase).toBe("stopped");
  });

  it("does not invoke the model after memory recall crosses the deadline", async () => {
    const { run, env, request, calls, expire } = await setup();
    env.SPECTRON_URL = "https://memory.test";
    request.mockImplementationOnce(async () => {
      expire();
      return Response.json({ context: "observed" });
    });
    await expect(run.message("hello")).rejects.toThrow(/limit/);
    expect(calls).toEqual([]);
  });

  it("does not verify a plan after planning crosses the deadline", async () => {
    const { run, request, calls, expire } = await setup({
      phase: "inspecting",
      pending: "inspect",
    });
    request.mockImplementation(async (input) => {
      if (String(input).includes("api.openai.com")) {
        calls.push("plan");
        expire();
        return Response.json({ output_text: JSON.stringify({ tasks: [] }) });
      }
      return new Response("<html>observed</html>");
    });
    await run.alarm();
    expect(calls).toEqual(["plan"]);
    expect((await run.getState()).phase).toBe("stopped");
  });

  it("does not dispatch a worker after preparation crosses the deadline", async () => {
    const { run, expire, startWorker } = await setup({
      phase: "building",
      tasks: [task("queued")],
    });
    vi.mocked(Daytona.prototype.writeFile).mockImplementationOnce(async () => {
      expire();
    });
    await run.alarm();
    expect(startWorker).not.toHaveBeenCalled();
    expect((await run.getState()).phase).toBe("stopped");
  });

  it("does not execute a worker when session creation crosses the deadline", async () => {
    const { run, expire, request, startWorker, env } = await setup({
      phase: "building",
      tasks: [task("queued")],
    });
    startWorker.mockRestore();
    env.DAYTONA_API_URL = "https://daytona.test";
    const paths: string[] = [];
    request.mockImplementation(async (input) => {
      const url = String(input);
      paths.push(url);
      if (url.endsWith("toolbox-proxy-url"))
        return Response.json({ url: "https://toolbox.test" });
      if (url.endsWith("/process/session")) {
        expire();
        return Response.json({});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await run.alarm();
    expect(paths).toHaveLength(2);
    expect((await run.getState()).phase).toBe("stopped");
  });

  it("does not review after collecting a worker crosses the deadline", async () => {
    const { run, expire, calls } = await setup({
      phase: "building",
      tasks: [task("building")],
    });
    vi.mocked(Daytona.prototype.exec).mockImplementation(async () => {
      expire();
      return { exitCode: 0, result: "0" };
    });
    await run.alarm();
    expect(calls).toEqual([]);
    expect((await run.getState()).phase).toBe("stopped");
  });

  it("does not verify a merge after the preview fetch crosses the deadline", async () => {
    const { run, expire, calls, request } = await setup({
      phase: "building",
      tasks: [task("failed")],
    });
    request.mockImplementationOnce(async () => {
      expire();
      return new Response("<html>rebuilt</html>");
    });
    await expect(run.override("t01", "approve", "yes")).rejects.toThrow(
      /limit/,
    );
    expect(calls).toEqual([]);
  });

  it("does not perform final verification after reading the preview crosses the deadline", async () => {
    const { run, expire, calls, request } = await setup({ phase: "building" });
    request.mockImplementationOnce(async () => {
      expire();
      return new Response("<html>rebuilt</html>");
    });
    await run.alarm();
    expect(calls).toEqual([]);
    expect((await run.getState()).phase).toBe("stopped");
  });

  it("still starts and converses, plans, dispatches and verifies within the deadline", async () => {
    const first = await setup({ empty: true });
    await first.run.start("r1", "https://example.com", "rebuild");
    await first.run.message("the hero");
    expect(first.calls).toEqual(["orchestrator_turn", "orchestrator_turn"]);
    await first.run.approveSpec();
    await first.run.alarm();
    expect(first.calls).toContain("plan");
    expect(first.calls).toContain("verify_plan");
    expect((await first.run.getState()).phase).toBe("planned");
    const planned = await setup({ phase: "planned" });
    await planned.run.startBuild();
    await planned.run.alarm();
    expect(Daytona.prototype.create).toHaveBeenCalled();
    expect(planned.startWorker).toHaveBeenCalled();
    const building = await setup({
      phase: "building",
      tasks: [task("queued")],
    });
    building.startWorker.mockClear();
    await building.run.alarm();
    expect(building.startWorker).toHaveBeenCalledOnce();
    await building.run.override("t01", "approve", "yes");
    expect(building.calls).toContain("verify_task");
    await building.run.alarm();
    expect(building.calls).toContain("verify_final");
    expect((await building.run.getState()).phase).toBe("done");
  });
});
