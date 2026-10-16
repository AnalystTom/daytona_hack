import { describe, expect, it, vi } from "vitest";
import { createRun, sendMessage } from "./runClient";

const reply = (status: number, body?: unknown) =>
  vi.fn(async () =>
    body === undefined
      ? new Response(null, { status })
      : Response.json(body, { status }),
  ) as unknown as typeof fetch;

describe("run client", () => {
  it("posts the brief and returns the run id", async () => {
    const fetchImpl = reply(201, { runId: "run_1" });
    expect(await createRun("copy daytona.io", fetchImpl)).toEqual({
      ok: true,
      value: { runId: "run_1" },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/runs",
      expect.objectContaining({
        method: "POST",
        body: '{"brief":"copy daytona.io"}',
      }),
    );
  });

  it("reports not connected while the route is missing or unreachable", async () => {
    const missing = await createRun("x", reply(404, { error: "Not found" }));
    expect(missing).toMatchObject({ ok: false, error: "not_connected" });
    const offline = await createRun(
      "x",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    );
    expect(offline).toMatchObject({ ok: false, error: "not_connected" });
  });

  it("maps auth failures and passes the server's reason through", async () => {
    expect(
      await createRun("x", reply(401, { error: "Sign in first" })),
    ).toEqual({
      ok: false,
      error: "sign_in_needed",
      detail: "Sign in first",
    });
    expect(
      await createRun(
        "x",
        reply(503, { error: "Missing binding DAYTONA_API_KEY" }),
      ),
    ).toEqual({
      ok: false,
      error: "failed",
      detail: "Missing binding DAYTONA_API_KEY",
    });
  });

  it("rejects a reply without a run id", async () => {
    expect(await createRun("x", reply(201, {}))).toMatchObject({
      ok: false,
      error: "failed",
    });
  });

  it("sends messages to the run's message endpoint", async () => {
    const fetchImpl = reply(202, {});
    expect(await sendMessage("run/1", "only the hero", fetchImpl)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/runs/run%2F1/messages",
      expect.objectContaining({ body: '{"text":"only the hero"}' }),
    );
  });
});
