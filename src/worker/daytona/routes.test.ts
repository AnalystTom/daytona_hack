import { describe, expect, it } from "vitest";
import { runBridgeToken } from "./bridge-token";
import { fakeDaytona } from "./fake-daytona";
import { type DaytonaEnv, handleSandboxRoute } from "./routes";

const allBindings: DaytonaEnv = {
  SANDBOX_API_TOKEN: "admin",
  DAYTONA_API_KEY: "dtn",
  OPENAI_API_KEY: "sk",
  BRIDGE_TOKEN: "bt",
};

function setup(env: DaytonaEnv = allBindings) {
  const fake = fakeDaytona();
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handleSandboxRoute(
      new Request(`https://reversy.test${path}`, {
        method,
        headers: { Authorization: "Bearer admin" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      () => fake.deps,
    );
    return response && { status: response.status, body: await response.json() };
  };
  return { call, fake };
}

describe("run sandbox routes", () => {
  it("ignores paths outside the sandbox routes", async () => {
    const { call } = setup();
    expect(await call("GET", "/api/v1/runs/r1/events")).toBeNull();
    expect(await call("GET", "/api/health")).toBeNull();
  });

  it("names exactly which bindings are missing", async () => {
    const { call } = setup({
      SANDBOX_API_TOKEN: "admin",
      DAYTONA_API_KEY: "dtn",
    });
    expect(await call("POST", "/api/v1/runs/r1/sandbox")).toEqual({
      status: 503,
      body: {
        error: "Missing binding: OPENAI_API_KEY, BRIDGE_TOKEN",
        missing: ["OPENAI_API_KEY", "BRIDGE_TOKEN"],
      },
    });
    const none = setup({});
    expect((await none.call("GET", "/api/v1/runs/r1/sandbox"))?.body).toEqual({
      error: "Missing binding: SANDBOX_API_TOKEN, DAYTONA_API_KEY",
      missing: ["SANDBOX_API_TOKEN", "DAYTONA_API_KEY"],
    });
  });

  it("serves reads, messages and cleanup without the start-only bindings", async () => {
    const { call } = setup({
      SANDBOX_API_TOKEN: "admin",
      DAYTONA_API_KEY: "dtn",
    });
    expect((await call("GET", "/api/v1/runs/r1/sandbox"))?.status).toBe(404);
    expect((await call("DELETE", "/api/v1/runs/r1/sandbox"))?.status).toBe(200);
    expect(
      (
        await call("POST", "/api/v1/runs/r1/sandbox/messages", {
          kind: "chat",
          text: "hi",
        })
      )?.status,
    ).toBe(404);
  });

  it("refuses callers without the sandbox API token", async () => {
    const { call, fake } = setup({
      ...allBindings,
      SANDBOX_API_TOKEN: "other",
    });
    expect(await call("POST", "/api/v1/runs/r1/sandbox")).toEqual({
      status: 401,
      body: { error: "Unauthorized" },
    });
    expect(fake.calls).toEqual([]);
  });

  it("starts, reports, messages and cleans up a run sandbox", async () => {
    const { call, fake } = setup();
    const started = await call("POST", "/api/v1/runs/r1/sandbox");
    expect(started).toMatchObject({
      status: 200,
      body: { runId: "r1", sandboxId: "sb1", boot: "ready" },
    });
    // The bridge posts back to the Worker that started the run, with a token for this run only.
    expect(fake.execs[0]?.envs?.REVERSY_API_URL).toBe("https://reversy.test");
    expect(fake.execs[0]?.envs?.BRIDGE_TOKEN).toBe(
      await runBridgeToken("bt", "r1"),
    );
    expect(JSON.stringify(fake.execs)).not.toContain('"bt"');

    expect(await call("GET", "/api/v1/runs/r1/sandbox")).toMatchObject({
      status: 200,
      body: { sandboxId: "sb1", previewUrl: "https://4173-sb1.test" },
    });
    expect(
      await call("POST", "/api/v1/runs/r1/sandbox/messages", {
        kind: "chat",
        text: "Only the landing page, please.",
      }),
    ).toEqual({ status: 202, body: { delivered: true } });
    expect(await call("POST", "/api/v1/runs/r1/pods", {})).toEqual({
      status: 201,
      body: { podId: "sb2", kind: "fork", parentSandboxId: "sb1" },
    });
    expect(await call("DELETE", "/api/v1/runs/r1/sandbox")).toEqual({
      status: 200,
      body: {
        runId: "r1",
        status: "succeeded",
        removed: ["sb2", "sb1"],
        failures: [],
      },
    });
    expect(await call("GET", "/api/v1/runs/r1/sandbox")).toEqual({
      status: 404,
      body: { error: "Run r1 has no sandbox" },
    });
  });

  it("rejects invalid captain input and unknown methods", async () => {
    const { call } = setup();
    expect(
      (await call("POST", "/api/v1/runs/r1/sandbox/messages", { kind: "chat" }))
        ?.status,
    ).toBe(400);
    expect((await call("PUT", "/api/v1/runs/r1/sandbox"))?.status).toBe(405);
  });

  it("returns 404 when messaging a run that has no sandbox", async () => {
    const { call } = setup();
    expect(
      await call("POST", "/api/v1/runs/r1/sandbox/messages", {
        kind: "chat",
        text: "hello",
      }),
    ).toEqual({ status: 404, body: { error: "Run r1 has no sandbox" } });
  });
});
