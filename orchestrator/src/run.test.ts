import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceRecord } from "../../src/shared/evidence";
import * as anchor from "../../src/worker/evidence/anchor";
import {
  CaptureError,
  captureRun,
  endSignIn,
  leftScope,
} from "../../src/worker/evidence/capture";
import type { EvidenceStore, SignIn } from "../../src/worker/evidence/store";
import { Daytona } from "./daytona";
import { capture, endSavedSignIn, evidenceStore, toEvidence } from "./inspect";
import { Run } from "./run";
import { llmJson } from "./services";
import type { Env, Evidence, Phase } from "./types";
import { verifyFinal } from "./verifier";

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
  endSavedSignIn: vi.fn(),
  evidenceStore: vi.fn(),
}));
vi.mock("./services", () => ({
  tracing: {},
  recall: async () => "",
  remember: async () => {},
  pageHtml: async () => ({ html: "<a href='/account'>", tool: "fetch" }),
  llmJson: vi.fn(async (_env: unknown, opts: { name: string }) =>
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
  ),
}));
vi.mock("./verifier", () => ({
  verifyPlan: async () => ({
    target: "plan",
    pass: true,
    summary: "",
    findings: [],
  }),
  verifyFinal: vi.fn(async () => ({
    target: "final",
    pass: true,
    summary: "",
    findings: [],
  })),
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

beforeEach(() => {
  captureMock.mockReset();
  vi.mocked(endSavedSignIn).mockReset();
  vi.mocked(evidenceStore).mockReset();
  vi.mocked(llmJson).mockClear();
  vi.mocked(verifyFinal).mockClear();
});

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function persistedRun(
  evidence: Evidence[] = [],
  phase: Phase = "planned",
) {
  const ctx = fakeCtx();
  await ctx.storage.put("state", {
    id: "run-1",
    phase,
    spec: {
      url: "https://example.com/",
      goal: "copy it",
      pages: [{ path: "/account", confirmed: true }],
      flows: [],
      openQuestions: [],
      approved: true,
      revision: 1,
    },
    chat: [],
    evidence,
    tasks: [],
    signInPaths: phase === "awaiting_sign_in" ? ["/account"] : undefined,
  });
  const run = new Run(ctx as never, {} as Env);
  await ctx.loaded();
  return { run, ctx };
}

describe("Run sign-in handoff", () => {
  it.each(["skip", "stop", "resume", "replace"] as const)(
    "serializes %s with pending session creation and cleans up owned sessions",
    async (action) => {
      const { run } = await persistedRun([], "awaiting_sign_in");
      let saved: SignIn | null = null;
      const store: EvidenceStore = {
        putEvidence: async () => {},
        getEvidence: async () => null,
        getContent: async () => null,
        saveSignIn: async (_id, signIn) => {
          saved = signIn;
        },
        takeSignIn: async () => {
          const signIn = saved;
          saved = null;
          return signIn;
        },
      };
      const deps = { anchorApiKey: "test-key", store, emit: () => {} };
      captureMock.mockImplementation((_env, id, request) =>
        captureRun(deps, id, request),
      );
      vi.mocked(endSavedSignIn).mockImplementation((_env, id) =>
        endSignIn(deps, id),
      );
      const creating = deferred<void>();
      const release = deferred<void>();
      const live = new Set<string>();
      let created = 0;
      const create = vi
        .spyOn(anchor, "createSession")
        .mockImplementation(async () => {
          const id = `session-${++created}`;
          if (created === 1) {
            creating.resolve();
            await release.promise;
          }
          live.add(id);
          return { id, liveViewUrl: `https://live.example.test/${id}` };
        });
      const end = vi
        .spyOn(anchor, "endSession")
        .mockImplementation(async (_key, id) => {
          live.delete(id);
        });

      const first = run.startSignIn();
      await creating.promise;
      const next =
        action === "skip"
          ? run.skipSignIn()
          : action === "stop"
            ? run.stop()
            : action === "resume"
              ? run.resumeSignIn()
              : run.startSignIn();
      await Promise.resolve();
      await Promise.resolve();
      expect(create).toHaveBeenCalledTimes(1);
      expect(endSavedSignIn).not.toHaveBeenCalled();
      expect((await run.getState()).phase).toBe("awaiting_sign_in");

      release.resolve();
      await Promise.all([first, next]);
      if (action === "replace") {
        expect(create).toHaveBeenCalledTimes(2);
        expect(live).toEqual(new Set(["session-2"]));
        await run.skipSignIn();
      } else if (action === "resume") {
        expect((await run.getState()).pending).toBe("resume_sign_in");
        expect(live).toEqual(new Set(["session-1"]));
        await expect(run.startSignIn()).rejects.toThrow(
          "no sign-in is pending",
        );
        await run.stop();
      }
      expect(live.size).toBe(0);
      expect(saved).toBeNull();
      expect(end).toHaveBeenCalledWith("test-key", "session-1");
      expect((await run.getState()).phase).toBe(
        action === "stop" || action === "resume" ? "stopped" : "inspecting",
      );
      if (action === "stop" || action === "resume") {
        await run.alarm();
        expect((await run.getState()).phase).toBe("stopped");
        expect(captureMock).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("allows another sign-in transition after creation fails", async () => {
    const { run } = await persistedRun([], "awaiting_sign_in");
    captureMock.mockRejectedValueOnce(new Error("Anchor unavailable"));
    captureMock.mockResolvedValueOnce({
      status: "awaiting_sign_in",
      liveViewUrl: "https://live.example.test/session-2",
    });
    const first = run.startSignIn();
    const second = run.startSignIn();
    await expect(first).rejects.toThrow("Anchor unavailable");
    await expect(second).resolves.toEqual({
      liveViewUrl: "https://live.example.test/session-2",
    });
    await run.skipSignIn();
    expect((await run.getState()).phase).toBe("inspecting");
  });

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

    expect(endSavedSignIn).not.toHaveBeenCalled();
    await run.skipSignIn();
    expect(endSavedSignIn).toHaveBeenCalledWith(expect.anything(), "run-1");
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

  it("ends the saved sign-in session when stopped while awaiting sign-in", async () => {
    const ctx = fakeCtx();
    const run = new Run(ctx as never, {} as Env);
    await ctx.loaded();
    captureMock.mockResolvedValue({ status: "captured", items: [] });
    await run.start("run-1", "https://example.com/", "copy it");
    await run.approveSpec();
    captureMock.mockResolvedValueOnce({
      status: "captured",
      items: [redirected],
    });
    await run.alarm();
    vi.mocked(endSavedSignIn).mockRejectedValueOnce(
      new Error("Evidence storage is not configured"),
    );

    const state = await run.stop();

    expect(endSavedSignIn).toHaveBeenCalledWith(expect.anything(), "run-1");
    expect(state.phase).toBe("stopped");
  });
});

describe("Run persisted evidence", () => {
  const html = new TextEncoder().encode("<main>Original page</main>");
  const png = new Uint8Array([0, 255, 13, 10]);
  const json = new TextEncoder().encode('{ "sandboxId": "string" }');
  const legacy = (
    id: string,
    kind: Evidence["kind"],
    ext: string,
  ): Evidence => ({
    ...toEvidence(redirected),
    id,
    kind,
    status: "observed",
    path: `evidence/${id}.${ext}`,
  });

  it("reads only member legacy blobs and keeps them available to planning, build and verification", async () => {
    const { run, ctx } = await persistedRun(
      [
        legacy("ev_001", "screenshot", "png"),
        legacy("ev_002", "html", "html"),
        legacy("ev_003", "styles", "json"),
        legacy("ev_004", "assets", "json"),
      ],
      "awaiting_sign_in",
    );
    for (const [id, bytes] of [
      ["ev_001", png],
      ["ev_002", html],
      ["ev_003", json],
      ["ev_004", json],
      ["ev_999", png],
    ] as const)
      await ctx.storage.put(`blob:${id}`, bytes.buffer);
    expect(await run.evidenceFile("ev_999")).toBeNull();
    for (const [id, type, content] of [
      ["ev_001", "image/png", png],
      ["ev_002", "text/html", html],
      ["ev_003", "application/json", json],
      ["ev_004", "application/json", json],
    ] as const) {
      expect(await run.evidenceFile(id)).toEqual({
        contentType: type,
        content,
      });
    }
    expect(evidenceStore).not.toHaveBeenCalled();

    await run.skipSignIn();
    await run.alarm();
    expect((await run.getState()).phase).toBe("planned");
    expect(vi.mocked(llmJson).mock.calls.at(-1)?.[1].input).toContain(
      "<main>Original page</main>",
    );

    vi.spyOn(Daytona.prototype, "create").mockResolvedValue({
      id: "sandbox-1",
    });
    vi.spyOn(Daytona.prototype, "must").mockResolvedValue("");
    const write = vi.spyOn(Daytona.prototype, "writeFile").mockResolvedValue();
    vi.spyOn(Daytona.prototype, "startAsync").mockResolvedValue("preview");
    vi.spyOn(Daytona.prototype, "previewUrl").mockResolvedValue(
      "https://preview.example.test",
    );
    vi.spyOn(Daytona.prototype, "signedPreviewUrl").mockResolvedValue(
      "https://preview.example.test/signed",
    );
    await run.startBuild();
    await run.alarm();
    for (const [path, bytes] of [
      ["ev_001.png", png],
      ["ev_002.html", html],
      ["ev_003.json", json],
      ["ev_004.json", json],
    ] as const)
      expect(write).toHaveBeenCalledWith(
        "sandbox-1",
        `/home/daytona/evidence/${path}`,
        bytes,
      );
    expect((await run.getState()).phase).toBe("building");
    await run.alarm();
    expect((await run.getState()).phase).toBe("done");
    expect(vi.mocked(verifyFinal).mock.calls[0]?.[5]).toBe(
      "<main>Original page</main>",
    );
  });

  it("reads modern evidence from the shared store without falling back to a local blob", async () => {
    const record = {
      ...redirected,
      label: "observed" as const,
      kind: "dom" as const,
      contentType: "text/html",
    };
    const { run, ctx } = await persistedRun([toEvidence(record)]);
    await ctx.storage.put(`blob:${record.id}`, png.buffer);
    const store: EvidenceStore = {
      putEvidence: async () => {},
      getEvidence: vi.fn(async () => record),
      getContent: vi.fn(async () => html),
      saveSignIn: async () => {},
      takeSignIn: async () => null,
    };
    vi.mocked(evidenceStore).mockReturnValue(store);
    expect(await run.evidenceFile(record.id)).toEqual({
      contentType: "text/html",
      content: html,
    });
    expect(store.getEvidence).toHaveBeenCalledWith(record.id);
    expect(store.getContent).toHaveBeenCalledWith(record.id);
    expect(
      await run.evidenceFile("ev_11111111-1111-4111-8111-111111111111"),
    ).toBeNull();
    expect(store.getEvidence).toHaveBeenCalledTimes(1);
  });
});
