import { D1RunStore } from "../../src/worker/store/d1";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as anchor from "../../src/worker/evidence/anchor";
import { captureRun } from "../../src/worker/evidence/capture";
import type { EvidenceStore, SignIn } from "../../src/worker/evidence/store";
import { Daytona } from "./daytona";
import { Run } from "./run";
import { remember, tracing } from "./services";
import type { Env } from "./types";
import * as verifier from "./verifier";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(pending = "plan") {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  const data = new Map<string, unknown>([
    [
      "state",
      {
        id: "shutdown-run",
        startedAt: Date.now() - 120 * 60_000 + 1000,
        phase: "inspecting",
        pending,
        sandboxId: "promoted",
        spec: {
          url: "https://example.com/",
          goal: "Rebuild",
          scope: "frontend",
          pages: [{ path: "/", confirmed: true }],
          flows: [],
          openQuestions: [],
          approved: true,
          revision: 1,
        },
        evidence: [
          { id: "ev_code", kind: "code", tool: "rea", status: "not_observed" },
        ],
        tasks: [],
        chat: [],
      },
    ],
  ]);
  let alarm: number | null = null;
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    },
    list: async () =>
      new Map([...data].filter(([key]) => key.startsWith("ev:"))),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
    async transaction<T>(
      fn: (s: {
        getAlarm: () => Promise<number | null>;
        setAlarm: (at: number) => Promise<void>;
      }) => Promise<T>,
    ): Promise<T> {
      return fn(storage);
    },
  };
  let ready = Promise.resolve();
  const ctx = {
    storage,
    blockConcurrencyWhile: (fn: () => Promise<void>) => {
      ready = fn();
    },
    waitUntil: () => {},
  };
  const run = new Run(ctx as unknown as DurableObjectState, {} as Env);
  await ready;
  alarm = null; // The runtime consumes the scheduled alarm before invoking its handler.
  vi.spyOn(Daytona.prototype, "exec").mockResolvedValue({
    exitCode: 0,
    result: "",
  });
  const stop = vi.spyOn(Daytona.prototype, "stop").mockResolvedValue();
  return { run, stop, alarm: () => alarm };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  tracing.current = undefined;
});

describe("shutdown edge regressions", () => {
  it.each(["verification", "sandbox preparation"])(
    "expires one foreground alarm while %s is still stalled",
    async (step) => {
      const { run, stop } = await fixture(
        step === "verification" ? "plan" : "build_setup",
      );
      const entered = deferred<void>();
      const blocked = deferred<never>();
      if (step === "verification") {
        vi.spyOn(verifier, "verifyPlan").mockImplementation(() => {
          entered.resolve();
          return blocked.promise;
        });
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => Response.json({ tasks: [] })),
        );
        // Only the planner is replaced; the alarm and verifier transition are real.
        const services = await import("./services");
        vi.spyOn(services, "llmJson").mockResolvedValue({ tasks: [] });
      } else {
        vi.spyOn(Daytona.prototype, "must").mockResolvedValue("");
        vi.spyOn(Daytona.prototype, "writeFile").mockImplementation(() => {
          entered.resolve();
          return blocked.promise;
        });
      }
      let finished = false;
      const running = run.alarm().then(() => {
        finished = true;
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1001);
      expect(stop).toHaveBeenCalledWith("promoted", expect.any(AbortSignal));
      expect((await run.getState()).phase).toBe("stopped");
      expect(finished).toBe(true);
      await running;
      // No second alarm or release of the stalled dependency is needed for cleanup.
    },
  );

  it("retries sandbox shutdown even while worker termination and one sandbox stop stall", async () => {
    const { run, stop, alarm } = await fixture();
    const state = await run.getState();
    state.startedAt = Date.now() - 121 * 60_000;
    state.sandboxIds = ["promoted", "variant"];
    vi.spyOn(Daytona.prototype, "exec").mockReturnValue(new Promise(() => {}));
    stop.mockImplementation((id) =>
      id === "promoted" ? new Promise(() => {}) : Promise.resolve(),
    );
    let finished = false;
    const running = run.alarm().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(stop).toHaveBeenCalledWith("variant", expect.any(AbortSignal));
    expect((await run.getState()).stoppingSandboxIds).toEqual(["promoted"]);
    expect(alarm()).not.toBeNull();
    expect(alarm()).toBeLessThanOrEqual(Date.now() + 10_000);
    expect(finished).toBe(true);
    await running;
  });

  it("sends no later Agent Memory request when the first scope POST returns after cancellation", async () => {
    const first = deferred<never[]>();
    const writingRows = vi.spyOn(D1RunStore.prototype,"rows").mockReturnValueOnce(first.promise);
    const controller = new AbortController();
    const writing = remember(
      {
        DB: {} as D1Database,
      } as Env,
      "org/reversy/run/shutdown",
      "observed evidence",
      undefined,
      undefined,
      controller.signal,
    );
    while (!writingRows.mock.calls.length) await Promise.resolve();
    controller.abort(new Error("run ended"));
    first.resolve([]);
    await expect(writing).rejects.toThrow("run ended");
    expect(writingRows).toHaveBeenCalledTimes(1);
  });

  it("forgets a late saved sign-in while Anchor close is still stalled", async () => {
    const save = deferred<void>();
    const entered = deferred<void>();
    let saved: SignIn | null = null;
    const store: EvidenceStore = {
      putEvidence: async () => {},
      getEvidence: async () => null,
      getContent: async () => null,
      saveSignIn: async (_id, value) => {
        entered.resolve();
        await save.promise;
        saved = value;
      },
      takeSignIn: async () => {
        const value = saved;
        saved = null;
        return value;
      },
    };
    vi.spyOn(anchor, "createSession").mockResolvedValue({
      id: "late-session",
      liveViewUrl: "https://live.example.test/",
    });
    const close = vi
      .spyOn(anchor, "endSession")
      .mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const emit = vi.fn();
    const result = captureRun(
      { anchorApiKey: "test", store, signal: controller.signal, emit },
      "shutdown-run",
      {
        mode: "full_pack",
        signIn: "start",
        scope: { origin: "https://example.com", paths: ["/"] },
      },
    );
    const cancelled = expect(result).rejects.toThrow("run ended");
    await entered.promise;
    controller.abort(new Error("run ended"));
    save.resolve();
    await cancelled;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(close).toHaveBeenCalledWith("test", "late-session");
    expect(saved).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });
});
