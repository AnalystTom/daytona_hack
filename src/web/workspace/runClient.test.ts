import { describe, expect, it, vi } from "vitest";
import {
  createRun,
  fetchEvents,
  fetchEvidence,
  fetchPreviewLink,
  overrideVerdict,
  runAction,
  sendMessage,
  signIn,
} from "./runClient";

const reply = (status: number, body?: unknown) =>
  vi.fn(async () =>
    body === undefined
      ? new Response(null, { status })
      : Response.json(body, { status }),
  ) as unknown as typeof fetch;

const brief = { url: "https://www.daytona.io/", goal: "copy the hero" };

describe("run client", () => {
  it("posts the URL and goal, relying on the session cookie, and returns the run id", async () => {
    const fetchImpl = reply(201, { id: "run_1", phase: "brief" });
    expect(await createRun(brief, fetchImpl)).toEqual({
      ok: true,
      value: { runId: "run_1" },
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(brief),
    });
  });

  it("asks for the operator token when the session is missing", async () => {
    expect(
      await runAction("run_1", "build", reply(401, { message: "Wrong" })),
    ).toMatchObject({ ok: false, error: "operator_token" });
    expect(await fetchEvents("run_1", 0, reply(401))).toMatchObject({
      ok: false,
      error: "operator_token",
    });
  });

  it("signs in by posting the token to the session endpoint", async () => {
    const fetchImpl = reply(204);
    expect(await signIn("op-token", fetchImpl)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"token":"op-token"}',
    });
    expect(await signIn("nope", reply(401))).toMatchObject({
      ok: false,
      error: "operator_token",
      detail: "The operator token was refused. Paste the current one.",
    });
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

  it("reads events and drops malformed ones", async () => {
    const good = { seq: 3, ts: "2026-10-16T12:00:00Z", type: "chat", data: {} };
    const fetchImpl = reply(200, [good, { seq: "x" }]);
    expect(await fetchEvents("run_1", 2, fetchImpl)).toEqual({
      ok: true,
      value: [good],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/runs/run_1/events?since=2",
      { method: "GET", headers: {}, body: undefined },
    );
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
