import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceRecord } from "../../src/shared/evidence";
import { CaptureError, leftScope } from "../../src/worker/evidence/capture";
import { capture } from "./inspect";
import { Run } from "./run";
import type { Env } from "./types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));
vi.mock("./inspect", async (original) => ({
  ...(await original<typeof import("./inspect")>()),
  capture: vi.fn(),
}));
vi.mock("./services", () => ({
  tracing: {},
  recall: async () => "",
  remember: async () => {},
  pageHtml: async () => ({ html: "<a href='/account'>", tool: "fetch" }),
  llmJson: async (_env: unknown, opts: { name: string }) =>
    opts.name === "plan"
      ? { tasks: [] }
      : {
          reply: "Which pages?",
          userApproved: false,
          spec: {
            pages: [{ path: "/account", confirmed: true, notes: "" }],
            flows: [],
            openQuestions: [],
          },
        },
}));
vi.mock("./verifier", () => ({
  verifyPlan: async () => ({
    target: "plan",
    pass: true,
    summary: "",
    findings: [],
  }),
}));

const captureMock = vi.mocked(capture);

// A Durable Object context backed by a Map; alarms are run by hand.
function fakeCtx() {
  const storage = new Map<string, unknown>();
  let loading: Promise<void> = Promise.resolve();
  return {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => void storage.set(key, value),
      list: async ({ prefix }: { prefix: string }) =>
        new Map([...storage].filter(([k]) => k.startsWith(prefix))),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
    // A Durable Object finishes this before it takes any call.
    blockConcurrencyWhile: (fn: () => Promise<void>) => {
      loading = fn();
      return loading;
    },
    loaded: () => loading,
    waitUntil: () => {},
    events: () =>
      [...storage].filter(([k]) => k.startsWith("ev:")).map(([, v]) => v),
  };
}

const redirected: EvidenceRecord = {
  id: "ev_00000000-0000-4000-8000-000000000000",
  runId: "run-1",
  kind: "screenshot",
  label: "not_observed",
  pageOrState: "/account @ desktop 1440",
  url: "https://example.com/account",
  tool: "anchor",
  capturedAt: "2026-10-16T10:00:00.000Z",
  contentHash: "sha256:00",
  limitations: [`Redirected to https://example.com/login, ${leftScope}.`],
  contentType: "text/plain",
  byteLength: 0,
};

beforeEach(() => captureMock.mockReset());

describe("Run sign-in handoff", () => {
  it("pauses for sign-in, survives a resume with no session, then plans on skip", async () => {
    const ctx = fakeCtx();
    const run = new Run(ctx as never, {} as Env);
    await ctx.loaded();
    captureMock.mockResolvedValue({ status: "captured", items: [] });
    await run.start("run-1", "https://example.com/", "copy it");
    await run.approveSpec();

    // Full pack: the confirmed page redirects to a login page.
    captureMock.mockResolvedValueOnce({
      status: "captured",
      items: [redirected],
    });
    await run.alarm();
    let state = await run.getState();
    expect(state.phase).toBe("awaiting_sign_in");
    expect(state.signInPaths).toEqual(["/account"]);
    await expect(run.startBuild()).rejects.toThrow();

    // Only the caller gets the live view URL; it is never stored or emitted.
    const live = "https://live.anchorbrowser.io?sessionId=secret";
    captureMock.mockResolvedValueOnce({
      status: "awaiting_sign_in",
      liveViewUrl: live,
    });
    expect(await run.startSignIn()).toEqual({ liveViewUrl: live });
    expect(captureMock.mock.lastCall?.[2]).toMatchObject({
      signIn: "start",
      scope: { origin: "https://example.com", paths: ["/account"] },
    });

    // Resume without a live session: back to waiting, not failed.
    captureMock.mockRejectedValueOnce(
      new CaptureError("No sign-in session to resume for this run.", 409),
    );
    await run.resumeSignIn();
    await run.alarm();
    state = await run.getState();
    expect(captureMock.mock.lastCall?.[2]).toMatchObject({ signIn: "resume" });
    expect(state.phase).toBe("awaiting_sign_in");
    expect(state.chat.at(-1)?.text).toContain("No sign-in session");

    await run.skipSignIn();
    await run.alarm();
    state = await run.getState();
    expect(state.phase).toBe("planned");
    expect(state.signInPaths).toBeUndefined();
    expect(JSON.stringify([state, ctx.events()])).not.toContain(live);
  });

  it("refuses sign-in actions when no sign-in is pending", async () => {
    const ctx = fakeCtx();
    const run = new Run(ctx as never, {} as Env);
    await ctx.loaded();
    captureMock.mockResolvedValue({ status: "captured", items: [] });
    await run.start("run-1", "https://example.com/", "copy it");
    await expect(run.startSignIn()).rejects.toThrow("no sign-in is pending");
    await expect(run.resumeSignIn()).rejects.toThrow("no sign-in is pending");
    await expect(run.skipSignIn()).rejects.toThrow("no sign-in is pending");
  });
});
