import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRun,
  fetchEvents,
  fetchEvidence,
  fetchPreviewLink,
  fetchRun,
  fetchRunHistory,
  overrideVerdict,
  runAction,
  sendMessage,
  startSignIn,
} from "./runClient";

const reply = (status: number, body?: unknown) =>
  vi.fn(async () =>
    body === undefined
      ? new Response(null, { status })
      : Response.json(body, { status }),
  ) as unknown as typeof fetch;

const brief = { url: "https://www.daytona.io/", goal: "copy the hero" };

function lockRunStarts() {
  const queues = new Map<string, Promise<unknown>>();
  const request = vi.fn((name: string, start: () => Promise<unknown>) => {
    const running = (queues.get(name) ?? Promise.resolve()).then(start);
    queues.set(
      name,
      running.catch(() => undefined),
    );
    return running;
  });
  vi.stubGlobal("navigator", { locks: { request } });
  return request;
}

afterEach(() => vi.unstubAllGlobals());

describe("run client", () => {
  it.each([undefined, {}])(
    "posts the brief without Web Locks (%j), relying on the session cookie",
    async (navigatorState) => {
      vi.stubGlobal("navigator", navigatorState);
      const fetchImpl = reply(201, { id: "run_1", phase: "brief" });
      expect(await createRun(brief, fetchImpl)).toEqual({
        ok: true,
        value: { runId: "run_1" },
      });
      expect(fetchImpl).toHaveBeenCalledWith("/api/v1/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify(brief),
      });
    },
  );

  it("establishes one visitor cookie before another client instance starts a run", async () => {
    const request = lockRunStarts();
    vi.resetModules();
    const otherTab = await import("./runClient");
    let cookie: string | undefined;
    const owners: string[] = [];
    let entered!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      const owner = cookie ?? `visitor_${owners.length + 1}`;
      owners.push(owner);
      const id = `run_${owners.length}`;
      if (owners.length === 1) {
        entered();
        await blocked;
      }
      cookie = owner;
      return Response.json({ id }, { status: 201 });
    });
    const first = createRun(brief, fetchImpl);
    const second = otherTab.createRun(brief, fetchImpl);
    try {
      await began;
      expect(request).toHaveBeenCalledTimes(2);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, value: { runId: "run_1" } },
      { ok: true, value: { runId: "run_2" } },
    ]);
    expect(owners).toEqual([cookie, cookie]);
  });

  it.each(["network", "response"])(
    "releases the creation lock after a %s failure",
    async (failure) => {
      lockRunStarts();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => {
          if (failure === "network") throw new TypeError("offline");
          return Response.json({});
        })
        .mockResolvedValueOnce(Response.json({ id: "run_2" }, { status: 201 }));
      const [failed, next] = await Promise.all([
        createRun(brief, fetchImpl),
        createRun(brief, fetchImpl),
      ]);
      expect(failed).toMatchObject({ ok: false });
      expect(next).toEqual({ ok: true, value: { runId: "run_2" } });
    },
  );

  it("never prompts for a token on any 401, including unstructured edge responses", async () => {
    for (const body of [
      { code: "access_required", message: "Sign in through Access" },
      undefined,
    ]) {
      for (const result of [
        await createRun(brief, reply(401, body)),
        await fetchEvents("run_1", 0, reply(401, body)),
        await fetchPreviewLink("run_1", undefined, reply(401, body)),
        await fetchEvidence(
          "/api/v1/runs/run_1/evidence/ev_1",
          reply(401, body),
        ),
      ])
        expect(result).toMatchObject({
          ok: false,
          error: "access_required",
          detail:
            "Sign in in a new tab, then return to this workspace and try again. Keep this tab open.",
        });
    }
  });

  it("identifies every request as AJAX so expired Access sessions reach recovery instead of a login redirect", async () => {
    const edge = vi.fn<typeof fetch>(async (_input, init) => {
      if (
        new Headers(init?.headers).get("X-Requested-With") !== "XMLHttpRequest"
      )
        throw new TypeError("CORS blocked login redirect");
      return new Response(null, { status: 401 });
    });
    for (const request of [
      () => createRun(brief, edge),
      () => sendMessage("r1", "Continue", edge),
      () => runAction("r1", "build", edge),
      () =>
        overrideVerdict(
          "r1",
          { taskId: "t01", verdict: "approve", reason: "" },
          edge,
        ),
      () => fetchEvents("r1", 0, edge),
      () => fetchRun("r1", edge),
      () => fetchRunHistory(edge),
      () => fetchPreviewLink("r1", undefined, edge),
      () => fetchEvidence("/api/v1/runs/r1/evidence/ev1", edge),
    ])
      expect(await request()).toMatchObject({
        ok: false,
        error: "access_required",
      });
    expect(edge).toHaveBeenCalledTimes(9);
  });

  it("reads a signed https preview link and refuses anything else", async () => {
    const url = "https://3000-abc.proxy.daytona.works/";
    expect(
      await fetchPreviewLink("run_1", undefined, reply(200, { url })),
    ).toEqual({
      ok: true,
      value: url,
    });
    expect(
      await fetchPreviewLink(
        "run_1",
        undefined,
        reply(200, { url: "javascript:x" }),
      ),
    ).toMatchObject({ ok: false, error: "failed" });
  });

  it("reports not connected when the service is unreachable", async () => {
    const offline = await createRun(
      brief,
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    );
    expect(offline).toMatchObject({ ok: false, error: "not_connected" });
  });

  it("shows the API's own error message", async () => {
    const reason = "No build started: tasks appear after the spec is approved.";
    expect(
      await runAction(
        "run_1",
        "build",
        reply(502, { code: "orchestrator_error", message: reason }),
      ),
    ).toEqual({ ok: false, error: "failed", detail: reason });
    expect(
      await createRun(brief, reply(400, { error: "url required" })),
    ).toEqual({ ok: false, error: "failed", detail: "url required" });
  });

  it("rejects a reply without a run id", async () => {
    expect(await createRun(brief, reply(201, {}))).toMatchObject({
      ok: false,
      error: "failed",
    });
  });

  it("sends messages, actions and overrides to the run's routes", async () => {
    const fetchImpl = reply(200, {});
    await sendMessage("run/1", "only the hero", fetchImpl);
    await runAction("run/1", "stop", fetchImpl);
    await overrideVerdict(
      "run/1",
      { taskId: "t02", verdict: "approve", reason: "" },
      fetchImpl,
    );
    const calls = vi.mocked(fetchImpl).mock.calls;
    expect(calls.map(([path, init]) => [path, init?.body])).toEqual([
      ["/api/v1/runs/run%2F1/messages", '{"text":"only the hero"}'],
      ["/api/v1/runs/run%2F1/stop", "{}"],
      [
        "/api/v1/runs/run%2F1/override",
        '{"taskId":"t02","verdict":"approve","reason":""}',
      ],
    ]);
  });

  it("starts secure sign-in and accepts only an https live view", async () => {
    const live = "https://live.anchorbrowser.io?sessionId=s1";
    const fetchImpl = reply(200, { liveViewUrl: live });
    expect(await startSignIn("run_1", fetchImpl)).toEqual({
      ok: true,
      value: live,
    });
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(
      "/api/v1/runs/run_1/sign-in",
    );
    const unsafe = await startSignIn(
      "run_1",
      reply(200, { liveViewUrl: "javascript:alert(1)" }),
    );
    expect(unsafe.ok).toBe(false);
  });

  it("reads events and drops malformed ones", async () => {
    const good = { seq: 3, ts: "2026-10-16T12:00:00Z", type: "chat", data: {} };
    const fetchImpl = reply(200, [good, { seq: "x" }]);
    expect(await fetchEvents("run_1", 2, fetchImpl)).toEqual({
      ok: true,
      value: [good],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/runs/run_1/events?since=2",
      {
        method: "GET",
        headers: { "X-Requested-With": "XMLHttpRequest" },
        body: undefined,
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("confirms a run before reading its first events, even if there are none", async () => {
    const fetchImpl = vi.fn(async (path: RequestInfo | URL) =>
      path === "/api/v1/runs/run_1"
        ? Response.json({ id: "run_1" })
        : Response.json([]),
    ) as unknown as typeof fetch;
    expect(await fetchEvents("run_1", 0, fetchImpl)).toEqual({
      ok: true,
      value: [],
    });
    expect(vi.mocked(fetchImpl).mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/runs/run_1",
      "/api/v1/runs/run_1/events?since=0",
    ]);
  });

  it("reads the caller's run history and refuses malformed history replies", async () => {
    const history = [{ id: "run_1", createdAt: "2026-10-16T12:00:00Z" }];
    const fetchImpl = reply(200, history);
    expect(await fetchRunHistory(fetchImpl)).toEqual({
      ok: true,
      value: history,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/runs",
      expect.objectContaining({ method: "GET" }),
    );
    expect(await fetchRunHistory(reply(200, [{ id: "run_1" }]))).toMatchObject({
      ok: false,
      error: "failed",
    });
  });

  it("reports an unknown run without reading its empty event stream", async () => {
    const fetchImpl = reply(404, { message: "Run missing not found." });
    expect(await fetchEvents("missing", 0, fetchImpl)).toEqual({
      ok: false,
      error: "not_found",
      detail: "Run missing not found.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not confirm unreadable run state as an empty event stream", async () => {
    const fetchImpl = reply(200, {});
    expect(await fetchEvents("run_1", 0, fetchImpl)).toMatchObject({
      ok: false,
      error: "failed",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fetches evidence as a blob", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("png", { headers: { "content-type": "image/png" } }),
    ) as unknown as typeof fetch;
    const result = await fetchEvidence(
      "/api/v1/runs/run_1/evidence/ev_1",
      fetchImpl,
    );
    expect(result.ok && (await result.value.text())).toBe("png");
  });
});
