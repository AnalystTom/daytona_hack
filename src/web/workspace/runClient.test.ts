import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRun,
  fetchEvents,
  fetchEvidence,
  operatorToken,
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

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  operatorToken.set("op-token");
});
afterEach(() => vi.unstubAllGlobals());

describe("run client", () => {
  it("posts the URL and goal with the operator token and returns the run id", async () => {
    const fetchImpl = reply(201, { id: "run_1", phase: "brief" });
    expect(await createRun(brief, fetchImpl)).toEqual({
      ok: true,
      value: { runId: "run_1" },
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer op-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(brief),
    });
  });

  it("says the operator token is needed instead of calling without one", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    const fetchImpl = reply(201, { id: "run_1" });
    expect(await createRun(brief, fetchImpl)).toMatchObject({
      ok: false,
      error: "operator_token",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks for the token again when it is refused", async () => {
    expect(
      await runAction("run_1", "build", reply(401, { message: "Wrong" })),
    ).toMatchObject({ ok: false, error: "operator_token" });
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

  it("reads events with the token and drops malformed ones", async () => {
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
        headers: { authorization: "Bearer op-token" },
        body: undefined,
      },
    );
  });

  it("asks for the token before reading events or evidence without one", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    const fetchImpl = reply(200, []);
    expect(await fetchEvents("run_1", 0, fetchImpl)).toMatchObject({
      ok: false,
      error: "operator_token",
    });
    expect(
      await fetchEvidence("/api/v1/runs/run_1/evidence/ev_1", fetchImpl),
    ).toMatchObject({ ok: false, error: "operator_token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches evidence with the token as a blob", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("png", { headers: { "content-type": "image/png" } }),
    ) as unknown as typeof fetch;
    const result = await fetchEvidence(
      "/api/v1/runs/run_1/evidence/ev_1",
      fetchImpl,
    );
    expect(result.ok && (await result.value.text())).toBe("png");
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.headers).toEqual({
      authorization: "Bearer op-token",
    });
  });
});
