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
import {
  fixturePageFacts,
  fixturePngBase64,
} from "../../src/worker/evidence/fixtures";
import { Daytona } from "./daytona";
import { capture, endSavedSignIn, evidenceStore, toEvidence } from "./inspect";
import { Run } from "./run";
import { llmJson } from "./services";
import type { Env, Evidence, Phase } from "./types";
import { verifyFinal, verifyPlan } from "./verifier";

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
vi.mock("./services", async (original) => ({
  ...(await original<typeof import("./services")>()),
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
  verifyPlan: vi.fn(async () => ({
    target: "plan",
    pass: true,
    summary: "",
    findings: [],
  })),
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
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
  captureMock.mockReset();
  vi.mocked(endSavedSignIn).mockReset().mockResolvedValue(undefined);
  vi.mocked(evidenceStore).mockReset();
  vi.mocked(llmJson).mockClear();
  vi.mocked(verifyFinal).mockClear();
  vi.mocked(verifyPlan).mockClear();
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
  empty = false,
  env: Partial<Env> = {},
) {
  const ctx = fakeCtx();
  if (!empty)
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
  const run = new Run(ctx as never, env as Env);
  await ctx.loaded();
  return { run, ctx };
}

function bindCapture(signIn: SignIn | null = null) {
  const records = new Map<string, EvidenceRecord>();
  const content = new Map<string, Uint8Array>();
  const store: EvidenceStore = {
    putEvidence: async (record, bytes) => {
      records.set(record.id, record);
      content.set(record.id, bytes);
    },
    getEvidence: async (id) => records.get(id) ?? null,
    getContent: async (id) => content.get(id) ?? null,
    saveSignIn: async (_id, value) => {
      signIn = value;
    },
    takeSignIn: async () => {
      const saved = signIn;
      signIn = null;
      return saved;
    },
  };
  captureMock.mockImplementation((_env, id, request, landed, control) =>
    captureRun(
      {
        ...control,
        anchorApiKey: "test-key",
        store: {
          ...store,
          putEvidence: async (record, bytes, signal) => {
            await store.putEvidence(record, bytes, signal);
            control?.signal?.throwIfAborted();
            await landed(toEvidence(record));
          },
        },
        emit: () => {},
      },
      id,
      request,
    ),
  );
  vi.mocked(endSavedSignIn).mockImplementation((_env, id) =>
    endSignIn({ anchorApiKey: "test-key", store }, id),
  );
  return { store, records, saved: () => signIn };
}

describe("Run sign-in handoff", () => {
  it("uses the final captured URL for REA while redacting event and planner labels", async () => {
    const { run } = await persistedRun([], "inspecting", false, {
      EVENTS_WEBHOOK_URL: "https://hooks.example/events",
    });
    const state = await run.getState();
    state.pending = "inspect";
    state.spec.pages = [{ path: "/docs", confirmed: true }];
    state.spec.scope = "frontend";
    const memory = bindCapture();
    vi.mocked(evidenceStore).mockReturnValue(memory.store);
    const finalUrl = "https://example.com/docs/?access_token=browser-secret";
    vi.spyOn(anchor, "createSession").mockResolvedValue({
      id: "capture",
      liveViewUrl: "https://live.example/capture",
    });
    vi.spyOn(anchor, "endSession").mockResolvedValue();
    vi.spyOn(anchor, "primaryRecording").mockResolvedValue(null);
    vi.spyOn(anchor, "runSnippet")
      .mockResolvedValue({ finalUrl, png: fixturePngBase64 })
      .mockResolvedValueOnce({
        ...fixturePageFacts(finalUrl),
        html: '<script src="main.js?token=bundle-secret"></script>',
      });
    const webhooks: unknown[] = [];
    const bundles: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url) === "https://hooks.example/events") {
        webhooks.push(JSON.parse(String(init?.body)));
        return new Response("");
      }
      bundles.push(String(url));
      return new Response("fetch('/api/x')");
    });
    vi.spyOn(Daytona.prototype, "create").mockResolvedValue({ id: "rea" });
    vi.spyOn(Daytona.prototype, "writeFile").mockResolvedValue();
    vi.spyOn(Daytona.prototype, "remove").mockResolvedValue();
    vi.spyOn(Daytona.prototype, "exec").mockResolvedValue({
      exitCode: 0,
      result: JSON.stringify({
        findings: [
          {
            kind: "api",
            value: "/api/x",
            file: "0.js",
            sha256: "hash",
            locator: "0.js:1:0",
            state: "observed",
          },
        ],
      }),
    });
    await run.alarm();
    expect((await run.getState()).phase).toBe("planned");
    expect(bundles).toEqual([
      "https://example.com/docs/main.js?token=bundle-secret",
    ]);
    expect(
      [...memory.records.values()].find((record) => record.kind === "dom")?.url,
    ).toBe(finalUrl);
    const code = (await run.getState()).evidence.find(
      (item) => item.kind === "code",
    );
    expect(code).toMatchObject({
      page: "/docs/",
      summary: "API call /api/x in https://example.com/docs/main.js",
    });
    expect(vi.mocked(verifyPlan).mock.calls[0]?.[2]).toContainEqual(code);
    expect(
      JSON.stringify([
        await run.events(0),
        webhooks,
        vi.mocked(llmJson).mock.calls,
      ]),
    ).not.toMatch(/browser-secret|bundle-secret/);
  });

  it("refuses to report stopped when allocation was interrupted without an ID", async () => {
    const { run, ctx } = await persistedRun(
      [
        {
          id: "ev_001",
          page: "/account",
          kind: "html",
          tool: "fetch",
          status: "observed",
          capturedAt: "now",
          hash: "hash",
          limits: "",
          summary: "HTML",
        },
      ],
      "awaiting_sign_in",
      false,
      { DAYTONA_API_URL: "https://daytona.example" },
    );
    await ctx.storage.put(
      "blob:ev_001",
      new TextEncoder().encode('<script src="main.js"></script>').buffer,
    );
    const allocating = deferred<void>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url) === "https://example.com/main.js")
        return new Response("fetch('/api/x')");
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
        allocating.resolve();
      });
    });
    await run.skipSignIn();
    const alarm = run.alarm();
    await allocating.promise;
    await expect(run.stop()).rejects.toThrow("Sandbox allocation unconfirmed");
    await alarm;
    expect((await run.getState()).phase).toBe("inspecting");
    expect((await run.getState()).pending).toBe("stop");
    expect(verifyPlan).not.toHaveBeenCalled();
  });

  it("resolves bundles from a stored DOM document's URL", async () => {
    const record: EvidenceRecord = {
      ...redirected,
      kind: "dom",
      label: "observed",
      url: "https://example.com/docs/",
      pageOrState: "/docs/",
      contentType: "text/html",
    };
    const { run } = await persistedRun(
      [toEvidence(record)],
      "awaiting_sign_in",
    );
    (await run.getState()).spec.pages.push({ path: "/docs/", confirmed: true });
    vi.mocked(evidenceStore).mockReturnValue({
      putEvidence: async () => {},
      getEvidence: async () => record,
      getContent: async () =>
        new TextEncoder().encode('<script src="main.js"></script>'),
      saveSignIn: async () => {},
      takeSignIn: async () => null,
    });
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        expect(String(url)).toBe("https://example.com/docs/main.js");
        return new Response("", { status: 404 });
      });
    await run.skipSignIn();
    await run.alarm();
    expect((await run.getState()).phase).toBe("planned");
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await run.getState()).evidence).toContainEqual(
      expect.objectContaining({
        kind: "code",
        page: "/docs/",
        status: "not_observed",
        limits: expect.stringContaining("HTTP 404"),
      }),
    );
  });

  it.each(["skip", "resume"] as const)(
    "scans only available approved document bundles on %s",
    async (action) => {
      const { run, ctx } = await persistedRun(
        [
          {
            id: "ev_001",
            page: "/unapproved/",
            kind: "html",
            tool: "fetch",
            status: "observed",
            capturedAt: "now",
            hash: "hash",
            limits: "",
            summary: "HTML",
          },
          {
            id: "ev_002",
            page: "/docs/",
            kind: "html",
            tool: "fetch",
            status: "observed",
            capturedAt: "now",
            hash: "hash",
            limits: "",
            summary: "HTML",
          },
        ],
        "awaiting_sign_in",
      );
      await ctx.storage.put(
        "blob:ev_001",
        new TextEncoder().encode('<script src="wrong.js"></script>').buffer,
      );
      (await run.getState()).spec.pages.push({
        path: "/docs/",
        confirmed: true,
      });
      await ctx.storage.put(
        "blob:ev_002",
        new TextEncoder().encode(
          '<base href="assets/"><script src="main.js"></script>',
        ).buffer,
      );
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (url) => {
          expect(String(url)).toBe("https://example.com/docs/assets/main.js");
          return new Response("fetch('/api/x')");
        });
      const create = vi
        .spyOn(Daytona.prototype, "create")
        .mockResolvedValue({ id: "rea" });
      vi.spyOn(Daytona.prototype, "writeFile").mockResolvedValue();
      vi.spyOn(Daytona.prototype, "exec").mockResolvedValue({
        exitCode: 0,
        result: JSON.stringify({
          findings: [
            {
              kind: "api",
              value: "/api/x",
              file: "0.js",
              sha256: "hash",
              locator: "0.js:1:0",
              state: "observed",
            },
          ],
        }),
      });
      const remove = vi.spyOn(Daytona.prototype, "remove").mockResolvedValue();
      captureMock.mockResolvedValue({ status: "captured", items: [] });
      if (action === "skip") await run.skipSignIn();
      else await run.resumeSignIn();
      await run.alarm();
      expect((await run.getState()).phase).toBe("planned");
      expect(vi.mocked(verifyPlan).mock.calls[0]?.[2]).toContainEqual(
        expect.objectContaining({
          kind: "code",
          page: "/docs/",
          summary: "API call /api/x in https://example.com/docs/assets/main.js",
        }),
      );
      expect(fetcher).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith("rea");
      if (action === "skip") expect(captureMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "stop awaits REA deletion and reports cleanup failure=%s",
    async (fails) => {
      const { run, ctx } = await persistedRun(
        [
          {
            id: "ev_001",
            page: "/account",
            kind: "html",
            tool: "fetch",
            status: "observed",
            capturedAt: "now",
            hash: "hash",
            limits: "",
            summary: "HTML",
          },
        ],
        "awaiting_sign_in",
      );
      await ctx.storage.put(
        "blob:ev_001",
        new TextEncoder().encode('<script src="main.js"></script>').buffer,
      );
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("fetch('/api/x')"),
      );
      vi.spyOn(Daytona.prototype, "create").mockResolvedValue({ id: "rea" });
      vi.spyOn(Daytona.prototype, "writeFile").mockResolvedValue();
      const scanning = deferred<void>();
      vi.spyOn(Daytona.prototype, "exec").mockImplementation(
        (_id, _command, opts) =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener(
              "abort",
              () => reject(opts.signal?.reason),
              { once: true },
            );
            scanning.resolve();
          }),
      );
      const deleting = deferred<void>();
      const release = deferred<void>();
      vi.spyOn(Daytona.prototype, "remove").mockImplementation(async () => {
        deleting.resolve();
        await release.promise;
        if (fails) throw new Error("cleanup unconfirmed");
      });
      await run.skipSignIn();
      const alarm = run.alarm();
      await scanning.promise;
      const stop = run.stop().then(
        () => undefined,
        (error: unknown) => error,
      );
      await deleting.promise;
      expect((await run.getState()).phase).toBe("inspecting");
      expect((await run.getState()).pending).toBe("stop");
      release.resolve();
      if (fails) {
        expect(await stop).toEqual(new Error("cleanup unconfirmed"));
        expect((await run.getState()).pending).toBe("stop");
      } else {
        expect(await stop).toBeUndefined();
        expect((await run.getState()).phase).toBe("stopped");
      }
      await alarm;
      expect(verifyPlan).not.toHaveBeenCalled();
    },
  );

  it.each(["skip", "resume", "expired"] as const)(
    "retains public backend evidence across a combined run's %s handoff",
    async (action) => {
      const ctx = fakeCtx();
      const run = new Run(ctx as never, {} as Env);
      await ctx.loaded();
      captureMock.mockResolvedValue({ status: "captured", items: [] });
      vi.mocked(llmJson).mockResolvedValueOnce({
        reply: "Both layers confirmed",
        userApproved: false,
        spec: {
          scope: "both",
          pages: [
            { path: "/", confirmed: true },
            { path: "/account", confirmed: true },
          ],
          flows: [],
          openQuestions: [],
        },
      });
      const requests: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        requests.push(url);
        if (url === "https://example.com/")
          return new Response('<a href="/api/public?id=1&amp;lang=en">API</a>');
        if (url === "https://example.com/account" && action === "resume")
          return Response.json({ items: [] });
        if (url.endsWith("/robots.txt") || url.endsWith("/sitemap.xml"))
          return new Response("", { status: 404 });
        throw new Error(`Unexpected request: ${url}`);
      });
      await run.start("run-1", "https://example.com/", "Rebuild both layers.");
      requests.length = 0; // Count backend inspection separately from startup redirect resolution.
      await run.approveSpec();
      captureMock.mockResolvedValueOnce({
        status: "captured",
        items: [redirected],
      });
      await run.alarm();
      const state = await run.getState();
      expect(state.phase).toBe("awaiting_sign_in");
      expect(state.signInPaths).toEqual(["/account"]);
      expect(state.evidence).toContainEqual(
        expect.objectContaining({
          page: "/",
          kind: "network",
          status: "observed",
          response: expect.objectContaining({ status: 200 }),
        }),
      );
      expect(state.evidence).toContainEqual(
        expect.objectContaining({
          page: "/",
          status: "inferred",
          routes: ["/api/public?id=1&lang=en"],
        }),
      );
      expect(requests).not.toContain("https://example.com/account");
      expect(verifyPlan).not.toHaveBeenCalled();
      if (action === "skip") await run.skipSignIn();
      else {
        if (action === "expired")
          captureMock.mockRejectedValueOnce(
            new CaptureError("No sign-in session to resume for this run.", 409),
          );
        await run.resumeSignIn();
      }
      await run.alarm();
      if (action === "expired") {
        expect((await run.getState()).phase).toBe("awaiting_sign_in");
        await run.skipSignIn();
        await run.alarm();
      }
      expect((await run.getState()).phase).toBe("planned");
      const planEvidence = vi.mocked(verifyPlan).mock.calls[0]?.[2];
      expect(planEvidence).toContainEqual(
        expect.objectContaining({
          page: "/",
          kind: "network",
          status: "observed",
        }),
      );
      expect(planEvidence).toContainEqual(
        expect.objectContaining({ routes: ["/api/public?id=1&lang=en"] }),
      );
      // Once for backend inspection, once for REA's own read of the page HTML.
      expect(
        requests.filter((url) => url === "https://example.com/"),
      ).toHaveLength(2);
      if (action === "resume") {
        expect(captureMock.mock.lastCall?.[2]).toMatchObject({
          signIn: "resume",
          scope: { paths: ["/account"] },
        });
        expect(planEvidence).toContainEqual(
          expect.objectContaining({
            page: "/account",
            kind: "network",
            status: "observed",
          }),
        );
      } else {
        expect(requests).not.toContain("https://example.com/account");
        expect(endSavedSignIn).toHaveBeenCalled();
      }
    },
  );

  it("does not inspect a fallback root when every combined capture path is stopped", async () => {
    const { run } = await persistedRun([], "brief");
    const state = await run.getState();
    state.spec.scope = "both";
    state.spec.pages = [{ path: "/", confirmed: true }];
    const requests = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No stopped page may be inspected"));
    captureMock.mockResolvedValueOnce({
      status: "captured",
      items: [
        {
          ...redirected,
          url: "https://example.com/",
          pageOrState: "/ @ desktop 1440",
        },
      ],
    });
    await run.approveSpec();
    await run.alarm();
    expect((await run.getState()).phase).toBe("awaiting_sign_in");
    expect((await run.getState()).signInPaths).toEqual(["/"]);
    expect(requests).not.toHaveBeenCalled();
    await run.skipSignIn();
    await run.alarm();
    expect((await run.getState()).phase).toBe("planned");
    expect(requests).not.toHaveBeenCalled();
  });

  it.each(["start", "resume", "skip", "gateway"] as const)(
    "refuses expired %s capture work without spending or reopening the run",
    async (action) => {
      const { run, ctx } = await persistedRun([], "awaiting_sign_in");
      const state = await run.getState();
      state.startedAt = Date.now() - 121 * 60_000;
      const result =
        action === "start"
          ? run.startSignIn()
          : action === "resume"
            ? run.resumeSignIn()
            : action === "skip"
              ? run.skipSignIn()
              : run.gatewayCapture("https://example.com/account");
      await expect(result).rejects.toThrow(/limit/);
      expect(captureMock).not.toHaveBeenCalled();
      expect(llmJson).not.toHaveBeenCalled();
      expect(await run.getState()).toMatchObject({
        phase: "stopped",
        pending: undefined,
      });
      expect(ctx.events()).toContainEqual(
        expect.objectContaining({ type: "phase", data: { phase: "stopped" } }),
      );
    },
  );

  it("retains the target query through first look, gateway, approval, secure sign-in and resume", async () => {
    const ctx = fakeCtx();
    const run = new Run(ctx as never, {} as Env);
    await ctx.loaded();
    const url = "https://example.com/search?q=robots&token=private";
    const target = "/search?q=robots&token=private";
    captureMock.mockResolvedValue({ status: "captured", items: [] });
    vi.mocked(llmJson).mockResolvedValueOnce({
      reply: "Search page confirmed",
      userApproved: false,
      spec: {
        pages: [{ path: "/search", confirmed: true }],
        flows: [],
        openQuestions: [],
      },
    });
    await run.start("run-1", url, "copy it");
    expect(captureMock.mock.lastCall?.[2].scope.paths).toEqual([target]);
    await run.gatewayCapture(url);
    expect(captureMock.mock.lastCall?.[2].scope.paths).toEqual([target]);
    expect(
      await run.gatewayCapture("https://example.com/search?q=agents"),
    ).toMatchObject({ status: 403 });
    expect(captureMock).toHaveBeenCalledTimes(2);
    await run.approveSpec();
    captureMock.mockResolvedValueOnce({
      status: "captured",
      items: [{ ...redirected, url }],
    });
    await run.alarm();
    expect(captureMock.mock.lastCall?.[2]).toMatchObject({
      mode: "full_pack",
      scope: { paths: [target] },
    });
    expect((await run.getState()).signInPaths).toEqual([target]);
    expect(
      JSON.stringify(
        ctx
          .events()
          .filter((event) => (event as { type: string }).type === "phase"),
      ),
    ).not.toContain("private");
    expect((await run.getState()).chat.at(-1)?.text).not.toContain("private");
    captureMock.mockResolvedValueOnce({
      status: "awaiting_sign_in",
      liveViewUrl: "https://live.example.test/sign-in",
    });
    await run.startSignIn();
    expect(captureMock.mock.lastCall?.[2]).toMatchObject({
      signIn: "start",
      scope: { paths: [target] },
    });
    await run.resumeSignIn();
    await run.alarm();
    expect(captureMock.mock.lastCall?.[2]).toMatchObject({
      signIn: "resume",
      scope: { paths: [target] },
    });
    expect((await run.getState()).phase).toBe("planned");
  });

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
    expect(state.evidence).toContainEqual(
      expect.objectContaining({
        kind: "code",
        tool: "rea",
        status: "not_observed",
        limits:
          "no approved page HTML was captured, and fetching it failed: every approved page needs sign-in",
      }),
    );
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

describe("Run inspection cancellation and recovery", () => {
  it("stays stopped when combined backend inspection settles before a sign-in handoff", async () => {
    const { run, ctx } = await persistedRun([], "brief");
    const state = await run.getState();
    state.spec.scope = "both";
    state.spec.pages = [
      { path: "/", confirmed: true },
      { path: "/pricing", confirmed: true },
      { path: "/account", confirmed: true },
    ];
    captureMock.mockResolvedValueOnce({
      status: "captured",
      items: [redirected],
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://example.com/") {
        entered.resolve();
        await release.promise;
        return new Response("");
      }
      return new Response("", { status: 404 });
    });
    await run.approveSpec();
    const inspection = run.alarm();
    await entered.promise;
    await run.stop();
    const stopped = structuredClone(await run.getState());
    const events = structuredClone(ctx.events());
    release.resolve();
    await inspection;
    expect(requests).toEqual(["https://example.com/"]);
    expect(await run.getState()).toEqual(stopped);
    expect((await run.getState()).phase).toBe("stopped");
    expect(ctx.events()).toEqual(events);
    expect(requests).not.toContain("https://example.com/pricing");
    expect(requests).not.toContain("https://example.com/account");
    expect(llmJson).not.toHaveBeenCalled();
    expect(verifyPlan).not.toHaveBeenCalled();
  });
  it.each(["inspect", "resume"] as const)(
    "blocks concurrent paid actions while %s Anchor cleanup is delayed",
    async (kind) => {
      const { run, ctx } = await persistedRun(
        [],
        kind === "resume" ? "awaiting_sign_in" : "brief",
      );
      const memory = bindCapture(
        kind === "resume"
          ? { sessionId: "active-session", origin: "https://example.com" }
          : null,
      );
      vi.spyOn(anchor, "createSession").mockResolvedValue({
        id: "active-session",
        liveViewUrl: "https://live.example.test/session",
      });
      const entered = deferred<void>();
      const releaseCapture = deferred<void>();
      const snippet = vi
        .spyOn(anchor, "runSnippet")
        .mockImplementation(async () => {
          entered.resolve();
          await releaseCapture.promise;
          return fixturePageFacts("https://example.com/account");
        });
      const closing = deferred<void>();
      const releaseCleanup = deferred<void>();
      const close = vi
        .spyOn(anchor, "endSession")
        .mockImplementation(async () => {
          closing.resolve();
          await releaseCleanup.promise;
        });
      if (kind === "resume") await run.resumeSignIn();
      else await run.approveSpec();
      const inspection = run.alarm();
      await entered.promise;
      const stopping = run.stop();
      await closing.promise;
      try {
        expect(await ctx.storage.get("state")).toMatchObject({
          phase: "inspecting",
          pending: "stop",
        });
        await expect(run.message("Keep working")).rejects.toThrow(/stopping/);
        await expect(
          run.override("t01", "approve", "Keep working"),
        ).rejects.toThrow(/stopping/);
        await expect(run.approveSpec()).rejects.toThrow(/stopping/);
        await expect(run.startBuild()).rejects.toThrow(/stopping/);
        await expect(
          run.gatewayCapture("https://example.com/account"),
        ).rejects.toThrow(/stopping/);
        const reloaded = new Run(ctx as never, {} as Env);
        await ctx.loaded();
        await expect(reloaded.message("Keep working")).rejects.toThrow(
          /stopping/,
        );
        expect(llmJson).not.toHaveBeenCalled();
        expect(captureMock).toHaveBeenCalledTimes(1);
        expect(memory.records.size).toBe(0);
      } finally {
        releaseCleanup.resolve();
        releaseCapture.resolve();
        await stopping;
        await inspection;
      }
      expect(await run.getState()).toMatchObject({
        phase: "stopped",
        pending: undefined,
      });
      expect(close).toHaveBeenCalledTimes(1);
      expect(snippet).toHaveBeenCalledTimes(1);
      expect(llmJson).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["resume", "success"],
    ["resume", "redirect"],
    ["resume", "failure"],
    ["inspect", "success"],
    ["gateway", "success"],
    ["first_look", "success"],
  ] as const)(
    "stays stopped after %s capture settles with %s",
    async (kind, outcome) => {
      const { run, ctx } = await persistedRun(
        [],
        kind === "resume" ? "awaiting_sign_in" : "brief",
        kind === "first_look",
      );
      const memory = bindCapture(
        kind === "resume"
          ? { sessionId: "active-session", origin: "https://example.com" }
          : null,
      );
      vi.spyOn(anchor, "createSession").mockResolvedValue({
        id: "active-session",
        liveViewUrl: "https://live.example.test/session",
      });
      const close = vi.spyOn(anchor, "endSession").mockResolvedValue();
      const entered = deferred<void>();
      const release = deferred<void>();
      const snippet = vi
        .spyOn(anchor, "runSnippet")
        .mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          if (outcome === "failure")
            throw new anchor.AnchorError("Session was closed");
          return fixturePageFacts(
            outcome === "redirect"
              ? "https://example.com/login"
              : kind === "first_look"
                ? "https://example.com/"
                : "https://example.com/account",
          );
        });
      let operation: Promise<unknown>;
      if (kind === "resume") {
        await run.resumeSignIn();
        operation = run.alarm();
      } else if (kind === "inspect") {
        await run.approveSpec();
        operation = run.alarm();
      } else if (kind === "gateway") {
        operation = run.gatewayCapture("https://example.com/account");
      } else {
        operation = run.start("run-1", "https://example.com/", "copy it");
      }
      const settled = operation.then(
        () => null,
        (error: Error) => error,
      );
      await entered.promise;
      await run.stop();
      expect(close).toHaveBeenCalledExactlyOnceWith(
        "test-key",
        "active-session",
      );
      const state = structuredClone(await run.getState());
      const events = structuredClone(ctx.events());
      release.resolve();
      const error = await settled;
      if (kind === "gateway") expect(error?.name).toBe("AbortError");
      else expect(error).toBeNull();
      expect(await run.getState()).toEqual(state);
      expect((await run.getState()).phase).toBe("stopped");
      expect(ctx.events()).toEqual(events);
      expect(memory.records.size).toBe(0);
      expect(memory.saved()).toBeNull();
      expect(snippet).toHaveBeenCalledTimes(1);
      expect(llmJson).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it("closes a session whose creation finishes after Stop", async () => {
    const { run, ctx } = await persistedRun([], "brief");
    bindCapture();
    const entered = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(anchor, "createSession").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return {
        id: "late-session",
        liveViewUrl: "https://live.example.test/late",
      };
    });
    const close = vi.spyOn(anchor, "endSession").mockResolvedValue();
    const snippet = vi
      .spyOn(anchor, "runSnippet")
      .mockRejectedValue(new Error("Unexpected browser call"));
    await run.approveSpec();
    const inspection = run.alarm();
    await entered.promise;
    await run.stop();
    const events = structuredClone(ctx.events());
    release.resolve();
    await inspection;
    expect(close).toHaveBeenCalledExactlyOnceWith("test-key", "late-session");
    expect(snippet).not.toHaveBeenCalled();
    expect((await run.getState()).phase).toBe("stopped");
    expect(ctx.events()).toEqual(events);
  });

  it("closes a resumed session taken from storage after Stop", async () => {
    const { run, ctx } = await persistedRun([], "awaiting_sign_in");
    const memory = bindCapture({
      sessionId: "late-session",
      origin: "https://example.com",
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    const take = memory.store.takeSignIn;
    vi.spyOn(memory.store, "takeSignIn").mockImplementationOnce(async (id) => {
      const saved = await take(id);
      entered.resolve();
      await release.promise;
      return saved;
    });
    const close = vi.spyOn(anchor, "endSession").mockResolvedValue();
    const snippet = vi
      .spyOn(anchor, "runSnippet")
      .mockRejectedValue(new Error("Unexpected browser call"));
    await run.resumeSignIn();
    const inspection = run.alarm();
    await entered.promise;
    await run.stop();
    const events = structuredClone(ctx.events());
    release.resolve();
    await inspection;
    expect(close).toHaveBeenCalledExactlyOnceWith("test-key", "late-session");
    expect(snippet).not.toHaveBeenCalled();
    expect(memory.saved()).toBeNull();
    expect((await run.getState()).phase).toBe("stopped");
    expect(ctx.events()).toEqual(events);
  });

  it("suppresses sign-in recovery events when Stop interrupts their state save", async () => {
    const { run, ctx } = await persistedRun([], "awaiting_sign_in");
    captureMock.mockResolvedValueOnce({
      status: "captured",
      items: [redirected],
    });
    await run.resumeSignIn();
    const entered = deferred<void>();
    const release = deferred<void>();
    const put = ctx.storage.put;
    vi.spyOn(ctx.storage, "put").mockImplementationOnce(async (key, value) => {
      await put(key, value);
      entered.resolve();
      await release.promise;
    });
    const inspection = run.alarm();
    await entered.promise;
    await run.stop();
    const state = structuredClone(await run.getState());
    const events = structuredClone(ctx.events());
    release.resolve();
    await inspection;
    expect(await run.getState()).toEqual(state);
    expect(ctx.events()).toEqual(events);
  });

  it.each([
    ["plan", "resolve"],
    ["plan", "reject"],
    ["verify", "resolve"],
    ["verify", "reject"],
  ] as const)(
    "discards an in-flight %s %s after Stop",
    async (stage, outcome) => {
      const { run, ctx } = await persistedRun([], "awaiting_sign_in");
      const entered = deferred<void>();
      const release = deferred<void>();
      if (stage === "plan") {
        vi.mocked(llmJson).mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          if (outcome === "reject") throw new Error("Late plan failure");
          return {
            tasks: [
              {
                id: "t01",
                title: "Late task",
                brief: "late",
                outOfScope: "",
                acceptance: [],
                evidence: [],
                owns: [],
                dependsOn: [],
              },
            ],
          };
        });
      } else {
        vi.mocked(verifyPlan).mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          if (outcome === "reject") throw new Error("Late verifier failure");
          return {
            target: "plan",
            pass: false,
            summary: "Late verdict",
            findings: [],
          };
        });
      }
      await run.skipSignIn();
      const inspection = run.alarm();
      await entered.promise;
      await run.stop();
      const state = structuredClone(await run.getState());
      const events = structuredClone(ctx.events());
      release.resolve();
      await inspection;
      expect((await run.getState()).phase).toBe("stopped");
      expect(await run.getState()).toEqual(state);
      expect(ctx.events()).toEqual(events);
      if (stage === "plan") expect(verifyPlan).not.toHaveBeenCalled();
    },
  );

  it.each(["retry", "skip"] as const)(
    "recovers from an expired resumed session through %s",
    async (action) => {
      const { run } = await persistedRun([], "awaiting_sign_in");
      const memory = bindCapture({
        sessionId: "expired-session",
        origin: "https://example.com",
      });
      const close = vi.spyOn(anchor, "endSession").mockResolvedValue();
      vi.spyOn(anchor, "createSession").mockResolvedValue({
        id: "new-session",
        liveViewUrl: "https://live.example.test/new",
      });
      let calls = 0;
      vi.spyOn(anchor, "runSnippet").mockImplementation(async () => {
        if (++calls === 1)
          throw new anchor.AnchorError(
            "Anchor POST execute-code failed with 404",
          );
        return (calls - 2) % 3 === 0
          ? fixturePageFacts("https://example.com/account")
          : { finalUrl: "https://example.com/account", png: fixturePngBase64 };
      });
      await run.resumeSignIn();
      await run.alarm();
      expect((await run.getState()).phase).toBe("awaiting_sign_in");
      expect((await run.getState()).signInPaths).toEqual(["/account"]);
      expect((await run.getState()).chat.at(-1)?.text).toContain(
        "open secure sign-in again",
      );
      expect(memory.saved()).toBeNull();
      expect(memory.records.size).toBe(0);
      expect(llmJson).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledWith("test-key", "expired-session");
      if (action === "retry") {
        await expect(run.startSignIn()).resolves.toEqual({
          liveViewUrl: "https://live.example.test/new",
        });
        await run.resumeSignIn();
      } else await run.skipSignIn();
      await run.alarm();
      expect((await run.getState()).phase).toBe("planned");
      expect((await run.getState()).signInPaths).toBeUndefined();
      expect(memory.saved()).toBeNull();
      if (action === "retry")
        expect(close).toHaveBeenCalledWith("test-key", "new-session");
    },
  );
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

describe("Run entered-URL redirects", () => {
  it("keeps fallback screenshots inferred and available in first look and gateway capture", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const memory = bindCapture();
    vi.mocked(evidenceStore).mockReturnValue(memory.store);
    vi.spyOn(anchor, "createSession").mockResolvedValue({
      id: "session",
      liveViewUrl: "https://live.example.test/session",
    });
    vi.spyOn(anchor, "endSession").mockResolvedValue();
    vi.spyOn(anchor, "runSnippet").mockRejectedValue(
      new anchor.CodeExecutionRefused("not enabled"),
    );
    const png = new Uint8Array([1, 2, 3]);
    vi.spyOn(anchor, "screenshotTool").mockResolvedValue(png);
    const ctx = fakeCtx();
    const run = new Run(ctx as never, {} as Env);
    await ctx.loaded();

    const state = await run.start("run-1", "https://example.com/", "copy it");

    expect(state.evidence).toContainEqual(
      expect.objectContaining({
        kind: "screenshot",
        status: "inferred",
        url: expect.stringMatching(/^\/runs\/run-1\/evidence\/ev_/),
      }),
    );
    expect(vi.mocked(llmJson).mock.calls.at(-1)?.[1].input).not.toContain(
      "No screenshot",
    );
    expect(await run.gatewayCapture("https://example.com/account")).toEqual({
      png,
    });
    expect(ctx.events()).toContainEqual(
      expect.objectContaining({
        type: "evidence",
        data: expect.objectContaining({
          kind: "screenshot",
          status: "inferred",
        }),
      }),
    );
    expect(
      [...memory.records.values()].every((r) => r.label === "inferred"),
    ).toBe(true);

    state.phase = "planned";
    state.tasks = [
      {
        id: "t01",
        title: "Rebuild",
        brief: "Rebuild",
        outOfScope: "",
        acceptance: [],
        evidence: [...memory.records.keys()],
        owns: ["index.html"],
        dependsOn: [],
        status: "queued",
        attempts: 0,
        branch: "task/t01",
      },
    ];
    vi.spyOn(Daytona.prototype, "create").mockResolvedValue({
      id: "sandbox-1",
    });
    vi.spyOn(Daytona.prototype, "must").mockResolvedValue("");
    const write = vi.spyOn(Daytona.prototype, "writeFile").mockResolvedValue();
    const start = vi
      .spyOn(Daytona.prototype, "startAsync")
      .mockResolvedValue("cmd");
    vi.spyOn(Daytona.prototype, "previewUrl").mockResolvedValue(
      "https://preview.example.test",
    );
    await run.startBuild();
    await run.alarm();
    await run.alarm();
    for (const record of memory.records.values()) {
      expect(write).toHaveBeenCalledWith(
        "sandbox-1",
        `/home/daytona/evidence/${record.id}.png`,
        png,
      );
      expect(start).toHaveBeenCalledWith(
        "sandbox-1",
        "w-t01-0",
        expect.stringContaining(`-i /home/daytona/evidence/${record.id}.png`),
        expect.any(Function),
      );
    }
  });

  // wikipedia.com answers 301 to wikipedia.org; the browser lands wherever `landing` says.
  function wikipedia(landing: (call: number) => string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) =>
        String(url) === "https://www.wikipedia.com/"
          ? new Response(null, {
              status: 301,
              headers: { location: "https://www.wikipedia.org/" },
            })
          : new Response("ok"),
      ),
    );
    bindCapture();
    vi.spyOn(anchor, "createSession").mockResolvedValue({
      id: "session",
      liveViewUrl: "https://live.example.test/session",
    });
    vi.spyOn(anchor, "endSession").mockResolvedValue();
    let calls = 0;
    vi.spyOn(anchor, "runSnippet").mockImplementation(async () => ({
      ...fixturePageFacts(landing(++calls)),
      png: fixturePngBase64,
    }));
  }

  it("scopes the run to the final origin and shows the redirect in the spec", async () => {
    wikipedia(() => "https://www.wikipedia.org/");
    const ctx = fakeCtx();
    const run = new Run(ctx as never, {} as Env);
    await ctx.loaded();
    const state = await run.start(
      "run-1",
      "https://www.wikipedia.com/",
      "copy it",
    );
    expect(captureMock.mock.calls[0]?.[2].scope).toEqual({
      origin: "https://www.wikipedia.org",
      paths: ["/"],
    });
    expect(state.spec.url).toBe("https://www.wikipedia.org/");
    expect(state.spec.redirects).toEqual([
      "https://www.wikipedia.com/",
      "https://www.wikipedia.org/",
    ]);
    expect(state.evidence).toContainEqual(
      expect.objectContaining({
        kind: "screenshot",
        status: "observed",
        page: "/ @ desktop 1440",
      }),
    );
    expect(state.evidence).toContainEqual(
      expect.objectContaining({
        kind: "redirects",
        status: "observed",
        summary:
          "You entered https://www.wikipedia.com/; it redirects to https://www.wikipedia.org/.",
      }),
    );
    const turn = vi.mocked(llmJson).mock.calls[0]?.[1] as {
      instructions: string;
      input: string;
    };
    expect(turn.input).toContain("it redirects to https://www.wikipedia.org/");
    expect(turn.input).not.toContain("No screenshot");
  });

  it("still stops a page that redirects off the final origin during capture", async () => {
    wikipedia((call) =>
      call === 1
        ? "https://www.wikipedia.org/"
        : "https://login.wikimedia.org/?returnto=x",
    );
    const ctx = fakeCtx();
    const run = new Run(ctx as never, {} as Env);
    await ctx.loaded();
    await run.start("run-1", "https://www.wikipedia.com/", "copy it");
    // The mocked chat turn confirms /account on the approved origin.
    await run.approveSpec();
    await run.alarm();
    expect(captureMock.mock.lastCall?.[2].scope.origin).toBe(
      "https://www.wikipedia.org",
    );
    const state = await run.getState();
    expect(state.phase).toBe("awaiting_sign_in");
    expect(state.signInPaths).toEqual(["/account"]);
  });

  it("tells the user in plain words why there is no screenshot, in a prompt without captain", async () => {
    wikipedia(() => "https://login.wikimedia.org/");
    const ctx = fakeCtx();
    const run = new Run(ctx as never, {} as Env);
    await ctx.loaded();
    await run.start("run-1", "https://www.wikipedia.com/", "copy it");
    const turn = vi.mocked(llmJson).mock.calls[0]?.[1] as {
      instructions: string;
      input: string;
    };
    expect(turn.input).toContain(
      "No screenshot: The site redirected to https://login.wikimedia.org/, outside the pages approved for this run",
    );
    // Every product prompt this run sent, not just the chat turn.
    for (const [, opts] of vi.mocked(llmJson).mock.calls)
      expect(JSON.stringify(opts)).not.toMatch(/captain/i);
  });
});
