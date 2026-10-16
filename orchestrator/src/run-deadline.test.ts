import { afterEach, describe, expect, it, vi } from "vitest";
import * as inspect from "./inspect";
import { Daytona } from "./daytona";
import { Run } from "./run";
import { tracing } from "./services";
import type { Env, Phase, Task } from "./types";
import orchestrator from "./index";
import {
  handleOrchestrator,
  type OrchestratorEnv,
} from "../../src/worker/orchestrator/front";
import {
  AUD,
  accessJwt,
  certs,
  TEAM,
} from "../../src/worker/orchestrator/access-fixtures";
import type { Owners, RunOwner } from "../../src/worker/orchestrator/owners";

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
    pending?: "inspect" | "build_setup" | "stop";
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
      return ready;
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
  vi.spyOn(inspect, "capture").mockImplementation(
    async (_env, _id, capture, _landed, control) => {
      await control?.beforeWork?.();
      await fetch(`${capture.scope.origin}${capture.scope.paths[0]}`);
      return { status: "captured", items: [] };
    },
  );
  vi.spyOn(Daytona.prototype, "exec").mockResolvedValue({
    exitCode: 0,
    result: "",
  });
  vi.spyOn(Daytona.prototype, "must").mockResolvedValue("");
  vi.spyOn(Daytona.prototype, "get").mockResolvedValue({
    id: "sb1",
    state: "started",
  });
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
    ctx,
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

function frontFor({ run, env, state }: Awaited<ReturnType<typeof setup>>) {
  const original: RunOwner = {
    runId: state.id,
    owner: "ada@example.com",
    createdAt: state.startedAt,
    active: true,
    busy: true,
    revision: 1,
  };
  const records = [{ ...original }];
  const owners: Owners = {
    get: async (id) => records.find((r) => r.runId === id) ?? null,
    list: async (owner) =>
      records.filter((r) => r.owner === owner).map((r) => ({ ...r })),
    finish: async (id, owner) => {
      const record = records.find((r) => r.runId === id && r.owner === owner);
      if (record) record.busy = false;
    },
    reserve: async (next, maxActive, _perDay, ended) => {
      for (const record of records) {
        if (
          !record.busy &&
          ended.some(
            (old) =>
              old.owner === record.owner &&
              old.runId === record.runId &&
              old.revision === record.revision,
          )
        )
          record.active = false;
      }
      const existing = records.find((r) => r.runId === next.runId);
      if (
        records.filter(
          (r) => r.owner === next.owner && r.active && r.runId !== next.runId,
        ).length >= maxActive ||
        existing?.busy
      )
        return "active_run_limit";
      if (existing) {
        existing.active = true;
        existing.busy = true;
        existing.revision = (existing.revision ?? 0) + 1;
      } else records.push({ ...next, active: true, busy: false });
      return undefined;
    },
  };
  const start = vi.fn(async (id: string) => ({ id, phase: "brief" }));
  const backend = {
    ...env,
    RUNS: {
      idFromName: (id: string) => id,
      get: (id: string) => (id === state.id ? run : { start }),
    },
  } as unknown as Env;
  const front: OrchestratorEnv = {
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ORCHESTRATOR: {
      fetch: (input: string, init?: RequestInit) =>
        orchestrator.fetch(new Request(input, init), backend),
    } as unknown as Fetcher,
  };
  const send = async (path: string, body?: Record<string, unknown>) =>
    handleOrchestrator(
      new Request(`https://reversy.test/api/v1/runs${path}`, {
        method: "POST",
        headers: {
          origin: "https://reversy.test",
          "cf-access-jwt-assertion": await accessJwt(),
        },
        body: JSON.stringify(
          body ?? (path ? {} : { url: "https://example.com", goal: "Rebuild" }),
        ),
      }),
      front,
      { owners, fetcher: certs },
    );
  return { send, start, records, original };
}

describe("provider-confirmed run cancellation", () => {
  it.each(
    ["explicit", "deadline", "admission"].flatMap((mode) =>
      [
        "stopped",
        "archived",
        "deleted",
        "started",
        "stopping",
        "starting",
        "error",
        "missing",
        "read failure",
        "command failure",
      ].map((provider) => [mode, provider]),
    ),
  )("handles %s stop with provider %s", async (mode, provider) => {
    const phase = mode === "admission" ? "done" : "building";
    const context = await setup({
      phase,
      tasks: [task("building")],
    });
    const { run, state, data, calls, startWorker, expire } = context;
    state.sandboxId = "sb1";
    const get = vi.mocked(Daytona.prototype.get);
    get.mockResolvedValue({
      state: provider === "missing" ? undefined : provider,
    });
    if (provider === "read failure")
      get.mockRejectedValue(new Error("provider read failed"));
    if (provider === "command failure") {
      get.mockResolvedValue({ state: "started" });
      vi.mocked(Daytona.prototype.must).mockRejectedValue(
        new Error("worker cancellation failed"),
      );
    }
    const client = frontFor(context);
    const confirmed = ["stopped", "archived", "deleted", "started"].includes(
      provider,
    );
    if (mode !== "explicit") expire();
    if (mode === "deadline") await run.alarm();
    else
      expect(
        (await client.send(mode === "explicit" ? "/r1/stop" : ""))?.status,
      ).toBe(confirmed ? (mode === "explicit" ? 200 : 201) : 502);
    expect(get).toHaveBeenCalledWith("sb1");
    expect(data.get("state")).toMatchObject({
      phase: confirmed ? "stopped" : phase,
      pending: confirmed ? undefined : "stop",
      startedAt: client.original.createdAt,
      tasks: [
        expect.objectContaining({ status: confirmed ? "stopped" : "building" }),
      ],
    });
    if (provider !== "started" && provider !== "command failure")
      expect(Daytona.prototype.must).not.toHaveBeenCalled();
    if (!confirmed) {
      expect(client.records[0]).toMatchObject(client.original);
      expect(client.start).not.toHaveBeenCalled();
      await expect(run.message("continue")).rejects.toThrow(/stopping/);
      expect((await client.send(""))?.status).toBe(
        mode === "explicit" ? 429 : 502,
      );
      get.mockResolvedValue({ state: "stopped" });
      if (mode === "explicit")
        expect((await client.send("/r1/stop"))?.status).toBe(200);
    }
    if (mode !== "admission" || !confirmed)
      expect((await client.send(""))?.status).toBe(201);
    expect(client.records[0]).toMatchObject({
      ...client.original,
      active: false,
      busy: false,
    });
    expect(client.start).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
    expect(startWorker).not.toHaveBeenCalled();
  });
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

  it.each(["brief", "building", "done", "failed"] as const)(
    "keeps %s runs blocked and nonterminal until worker cancellation completes",
    async (phase) => {
      const { run, state, data, ctx, env, calls, storage, startWorker } =
        await setup({ phase, tasks: [task("building")] });
      state.sandboxId = "sb1";
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<string>((resolve) => {
        release = () => resolve("");
      });
      vi.mocked(Daytona.prototype.must).mockImplementationOnce(async () => {
        entered();
        return blocked;
      });
      const stopping = run.stop();
      await started;
      expect(await run.getState()).toMatchObject({ phase, pending: "stop" });
      expect(data.get("state")).toMatchObject({ phase, pending: "stop" });
      const reloaded = new Run(ctx as unknown as DurableObjectState, env);
      await Promise.resolve();
      await expect(reloaded.message("continue")).rejects.toThrow(/stopping/);
      await expect(run.override("t01", "approve", "continue")).rejects.toThrow(
        /stopping/,
      );
      await run.alarm();
      expect(storage.setAlarm).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(startWorker).not.toHaveBeenCalled();
      release();
      await stopping;
      expect(await run.getState()).toMatchObject({
        phase: "stopped",
        pending: undefined,
      });
      expect(data.get("state")).toMatchObject({
        phase: "stopped",
        pending: undefined,
      });
    },
  );

  it.each(["network", "command"] as const)(
    "keeps cancellation pending after a %s failure until an explicit successful stop",
    async (kind) => {
      const { run, data, calls, storage } = await setup({
        phase: "building",
        tasks: [task("building")],
      });
      vi.mocked(Daytona.prototype.must).mockRestore();
      if (kind === "network")
        vi.mocked(Daytona.prototype.exec).mockRejectedValueOnce(
          new Error("toolbox unavailable"),
        );
      else
        vi.mocked(Daytona.prototype.exec).mockResolvedValueOnce({
          exitCode: 1,
          result: "workers still running",
        });
      await expect(run.stop()).rejects.toThrow();
      expect(data.get("state")).toMatchObject({
        phase: "building",
        pending: "stop",
      });
      await expect(run.message("continue")).rejects.toThrow(/stopping/);
      await expect(run.override("t01", "reject", "retry")).rejects.toThrow(
        /stopping/,
      );
      await run.alarm();
      expect(calls).toEqual([]);
      expect(storage.setAlarm).not.toHaveBeenCalled();
      await run.stop();
      expect(await run.getState()).toMatchObject({
        phase: "stopped",
        pending: undefined,
      });
    },
  );

  it("keeps expired runs blocked when cancellation fails", async () => {
    const { run, expire, data, calls, storage } = await setup({
      phase: "building",
      tasks: [task("building")],
    });
    vi.mocked(Daytona.prototype.must).mockRejectedValueOnce(
      new Error("cancellation refused"),
    );
    expire();
    await run.alarm();
    expect(data.get("state")).toMatchObject({
      phase: "building",
      pending: "stop",
    });
    await run.alarm();
    expect(calls).toEqual([]);
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it("checks the deadline again after worker launch returns", async () => {
    const { run, expire, calls, startWorker } = await setup({
      phase: "building",
      tasks: [task("queued")],
    });
    startWorker.mockImplementationOnce(async () => {
      expire();
      return "cmd1";
    });
    await run.alarm();
    expect(startWorker).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
    expect(await run.getState()).toMatchObject({
      phase: "stopped",
      pending: undefined,
    });
  });

  it("blocks plan verification after stop arrives during planning", async () => {
    const { run, request, calls } = await setup({
      phase: "inspecting",
      pending: "inspect",
    });
    request.mockImplementation(async (input) => {
      if (String(input).includes("api.openai.com")) {
        calls.push("plan");
        await run.stop();
        return Response.json({ output_text: JSON.stringify({ tasks: [] }) });
      }
      return new Response("<html>observed</html>");
    });
    await run.alarm();
    expect(calls).toEqual(["plan"]);
    expect((await run.getState()).phase).toBe("stopped");
  });

  it.each(["provider", "json", "refusal", "recording"] as const)(
    "makes final verification %s failures terminal without another paid attempt",
    async (failure) => {
      const { run, request, calls, storage, ctx, env, data } = await setup({
        phase: "building",
      });
      request.mockImplementation(async (input, init) => {
        if (String(input).includes("api.openai.com")) {
          const body = JSON.parse(String(init?.body));
          calls.push(body.text.format.name);
          if (failure === "provider")
            return Response.json({ error: "unavailable" }, { status: 503 });
          if (failure === "json") return Response.json({ output_text: "{" });
          if (failure === "refusal")
            return Response.json({
              output: [{ content: [{ type: "refusal", refusal: "No" }] }],
            });
          return Response.json({
            output_text: JSON.stringify({
              pass: true,
              findings: [],
              summary: "Pass",
            }),
          });
        }
        return new Response("<html>observed</html>");
      });
      if (failure === "recording") {
        const put = storage.put;
        let failed = false;
        storage.put = async (key, value) => {
          if (
            !failed &&
            typeof value === "object" &&
            value !== null &&
            "type" in value &&
            value.type === "verification"
          ) {
            failed = true;
            throw new Error("event write failed");
          }
          await put(key, value);
        };
      }
      await run.alarm();
      expect(await run.getState()).toMatchObject({
        phase: "failed",
        error: expect.any(String),
      });
      expect(data.get("state")).toMatchObject({ phase: "failed" });
      expect(storage.deleteAlarm).toHaveBeenCalled();
      expect(storage.setAlarm).not.toHaveBeenCalled();
      await run.alarm();
      const reloaded = new Run(ctx as unknown as DurableObjectState, env);
      await Promise.resolve();
      await reloaded.alarm();
      expect(calls).toEqual(["verify_final"]);
      expect(storage.setAlarm).not.toHaveBeenCalled();
    },
  );

  it.each(["approve", "reject"] as const)(
    "allows explicit %s continuation after completion without extending the deadline",
    async (verdict) => {
      const { run, state, calls, startWorker } = await setup({
        phase: "done",
        tasks: [task("failed")],
      });
      state.sandboxId = "sb1";
      state.previewUrl = "https://preview.test/";
      const startedAt = state.startedAt;
      await run.override("t01", verdict, "Make a variant");
      expect(await run.getState()).toMatchObject({
        id: "r1",
        phase: "building",
        startedAt,
      });
      if (verdict === "approve") expect(calls).toContain("verify_task");
      else {
        await run.alarm();
        expect(startWorker).toHaveBeenCalledOnce();
      }
      expect((await run.getState()).startedAt).toBe(startedAt);
    },
  );

  it.each(["provider", "json", "recording", "alarm"] as const)(
    "makes completed-run override %s failures terminal and retires admission without paid retries",
    async (failure) => {
      const context = await setup({ phase: "done", tasks: [task("failed")] });
      const {
        run,
        state,
        request,
        calls,
        storage,
        data,
        ctx,
        env,
        startWorker,
      } = context;
      state.sandboxId = "sb1";
      state.previewUrl = "https://preview.test/";
      const client = frontFor(context);
      client.records[0].busy = false;
      request.mockImplementation(async (input, init) => {
        if (String(input).includes("api.openai.com")) {
          const body = JSON.parse(String(init?.body)) as {
            text: { format: { name: string } };
          };
          calls.push(body.text.format.name);
          if (failure === "provider")
            return Response.json({ error: "unavailable" }, { status: 503 });
          if (failure === "json") return Response.json({ output_text: "{" });
          return Response.json({
            output_text: JSON.stringify({
              pass: true,
              findings: [],
              summary: "Pass",
            }),
          });
        }
        return new Response("<html>Observed page</html>");
      });
      if (failure === "recording") {
        const put = storage.put;
        let failed = false;
        storage.put = async (key, value) => {
          if (
            !failed &&
            typeof value === "object" &&
            value !== null &&
            "type" in value &&
            value.type === "verification"
          ) {
            failed = true;
            throw new Error("verification write failed");
          }
          await put(key, value);
        };
      }
      if (failure === "alarm")
        storage.setAlarm.mockRejectedValueOnce(new Error("alarm write failed"));
      const body = {
        taskId: "t01",
        verdict: failure === "alarm" ? "reject" : "approve",
        reason: "Make a variant",
      };
      expect((await client.send("/r1/override", body))?.status).toBe(502);
      expect(data.get("state")).toMatchObject({
        id: "r1",
        phase: "failed",
        error: expect.any(String),
        startedAt: client.original.createdAt,
      });
      expect(client.records[0]).toMatchObject({
        ...client.original,
        revision: 2,
        busy: false,
      });
      expect(storage.deleteAlarm).toHaveBeenCalled();
      const alarmAttempts = storage.setAlarm.mock.calls.length;
      await run.alarm();
      const reloaded = new Run(ctx as unknown as DurableObjectState, env);
      await Promise.resolve();
      await reloaded.alarm();
      expect((await client.send("/r1/override", body))?.status).toBe(502);
      expect(storage.setAlarm.mock.calls).toHaveLength(alarmAttempts);
      expect(calls).toEqual(failure === "alarm" ? [] : ["verify_task"]);
      expect(startWorker).not.toHaveBeenCalled();
      expect((await client.send(""))?.status).toBe(201);
      expect(client.start).toHaveBeenCalledOnce();
      expect(client.records[0]).toMatchObject({
        runId: "r1",
        owner: client.original.owner,
        createdAt: client.original.createdAt,
        active: false,
        busy: false,
      });
      expect(calls).toEqual(failure === "alarm" ? [] : ["verify_task"]);
    },
  );

  it("does not reopen paid verification when an already merged task is approved again", async () => {
    const { run, calls } = await setup({
      phase: "done",
      tasks: [task("merged")],
    });
    await run.override("t01", "approve", "Keep it");
    await run.alarm();
    expect((await run.getState()).phase).toBe("done");
    expect(calls).toEqual([]);
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
