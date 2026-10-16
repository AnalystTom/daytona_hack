import { describe, expect, it } from "vitest";
import { handleOrchestrator, type OrchestratorEnv } from "./front";

type Seen = { method: string; url: string; headers: Headers; body: string };

// A stand-in for the service binding: records each request and answers with `reply`.
function binding(reply: (seen: Seen) => Response = () => Response.json({})) {
  const seen: Seen[] = [];
  const fetcher = {
    async fetch(input: string, init: RequestInit = {}) {
      const request = new Request(input, init);
      const entry = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: await request.text(),
      };
      seen.push(entry);
      return reply(entry);
    },
  } as unknown as Fetcher;
  return { fetcher, seen };
}

const operator = { authorization: "Bearer operator-secret" };

async function call(
  path: string,
  init: RequestInit & { json?: unknown } = {},
  env: OrchestratorEnv = {},
) {
  const { json, ...rest } = init;
  const body = json === undefined ? rest.body : JSON.stringify(json);
  return handleOrchestrator(
    new Request(`https://reversy.test${path}`, { ...rest, body }),
    env,
  );
}

const setup = (reply?: (seen: Seen) => Response) => {
  const { fetcher, seen } = binding(reply);
  return {
    seen,
    env: { ORCHESTRATOR: fetcher, OPERATOR_TOKEN: "operator-secret" },
  };
};

describe("operator pass-through", () => {
  it("needs the operator token", async () => {
    const { env, seen } = setup();
    const missing = await call("/api/v1/orchestrator/runs/x", {}, env);
    expect(missing?.status).toBe(401);
    const wrong = await call(
      "/api/v1/orchestrator/runs/x",
      { headers: { authorization: "Bearer nope" } },
      env,
    );
    expect(wrong?.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("answers 503 naming what is not configured", async () => {
    const noToken = await call(
      "/api/v1/orchestrator/runs/x",
      { headers: operator },
      { ORCHESTRATOR: binding().fetcher },
    );
    expect(noToken?.status).toBe(503);
    expect(await noToken?.json()).toMatchObject({
      message: expect.stringContaining("OPERATOR_TOKEN"),
    });
    const noBinding = await call(
      "/api/v1/orchestrator/runs/x",
      { headers: operator },
      { OPERATOR_TOKEN: "operator-secret" },
    );
    expect(noBinding?.status).toBe(503);
    expect(await noBinding?.json()).toMatchObject({
      message: expect.stringContaining("ORCHESTRATOR"),
    });
  });

  it("forwards method, path, query, body and token, without CORS", async () => {
    const { env, seen } = setup(
      () =>
        new Response('{"ok":true}', {
          status: 201,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          },
        }),
    );
    const response = await call(
      "/api/v1/orchestrator/runs/r1/events?since=4",
      { method: "POST", headers: operator, json: { text: "hi" } },
      env,
    );
    expect(response?.status).toBe(201);
    expect(response?.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response?.json()).toEqual({ ok: true });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("https://orchestrator/runs/r1/events?since=4");
    expect(seen[0]?.body).toBe('{"text":"hi"}');
    // Forwarded: the orchestrator's /sandboxes routes check the operator token themselves.
    expect(seen[0]?.headers.get("authorization")).toBe(
      "Bearer operator-secret",
    );
  });
});

describe("removed sandbox gateway", () => {
  it("is not reachable through reversy", async () => {
    const { env, seen } = setup();
    expect(
      await call(
        "/api/v1/gateway/capture",
        { method: "POST", headers: { authorization: "Bearer x" }, json: {} },
        env,
      ),
    ).toBeNull();
    expect(seen).toHaveLength(0);
  });
});

describe("run routes", () => {
  it("ignores paths outside the run API", async () => {
    expect(await call("/api/v1/evidence/e1")).toBeNull();
    expect(await call("/api/health")).toBeNull();
  });

  it("creates a run with the operator token and a checked URL", async () => {
    const { env, seen } = setup(() =>
      Response.json({ id: "r1" }, { status: 201 }),
    );
    const goal = "Rebuild the landing page";
    const anonymous = await call(
      "/api/v1/runs",
      { method: "POST", json: { url: "https://example.com", goal } },
      env,
    );
    expect(anonymous?.status).toBe(401);
    const local = await call(
      "/api/v1/runs",
      {
        method: "POST",
        headers: operator,
        json: { url: "https://localhost", goal },
      },
      env,
    );
    expect(local?.status).toBe(400);
    expect(seen).toHaveLength(0);

    const created = await call(
      "/api/v1/runs",
      {
        method: "POST",
        headers: operator,
        json: { url: "https://example.com", goal },
      },
      env,
    );
    expect(created?.status).toBe(201);
    expect(await created?.json()).toEqual({ id: "r1" });
    expect(seen[0]?.url).toBe("https://orchestrator/runs");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      url: "https://example.com/",
      goal,
    });
  });

  it("guards every action that steers a run", async () => {
    const { env, seen } = setup();
    for (const action of [
      "messages",
      "approve",
      "build",
      "stop",
      "override",
      "sign-in",
      "sign-in/resume",
      "sign-in/skip",
    ]) {
      const response = await call(
        `/api/v1/runs/r1/${action}`,
        { method: "POST", json: {} },
        env,
      );
      expect(response?.status).toBe(401);
    }
    expect(seen).toHaveLength(0);
  });

  it("forwards actions with validated bodies", async () => {
    const { env, seen } = setup();
    const post = (action: string, json: unknown = {}) =>
      call(
        `/api/v1/runs/r1/${action}`,
        { method: "POST", headers: operator, json },
        env,
      );

    expect((await post("messages", { text: "only the hero" }))?.status).toBe(
      200,
    );
    expect((await post("messages", { text: "" }))?.status).toBe(400);
    expect(
      (
        await post("override", {
          taskId: "t02",
          verdict: "approve",
          reason: "fine",
        })
      )?.status,
    ).toBe(200);
    expect(
      (await post("override", { taskId: "t02", verdict: "maybe" }))?.status,
    ).toBe(400);
    for (const action of [
      "approve",
      "build",
      "stop",
      "sign-in",
      "sign-in/resume",
      "sign-in/skip",
    ]) {
      expect((await post(action))?.status).toBe(200);
    }
    expect((await post("sign-in/other"))?.status).toBe(404);
    expect((await post("delete"))?.status).toBe(404);
    expect(
      seen.map((s) => `${s.method} ${new URL(s.url).pathname} ${s.body}`),
    ).toEqual([
      'POST /runs/r1/messages {"text":"only the hero"}',
      'POST /runs/r1/override {"taskId":"t02","verdict":"approve","reason":"fine"}',
      "POST /runs/r1/approve {}",
      "POST /runs/r1/build {}",
      "POST /runs/r1/stop {}",
      "POST /runs/r1/sign-in {}",
      "POST /runs/r1/sign-in/resume {}",
      "POST /runs/r1/sign-in/skip {}",
    ]);
  });

  it("needs the operator token to read state, events and evidence", async () => {
    const { env, seen } = setup();
    for (const path of [
      "/api/v1/runs/r1",
      "/api/v1/runs/r1/events?since=0",
      "/api/v1/runs/r1/evidence/ev_001",
    ]) {
      expect((await call(path, {}, env))?.status).toBe(401);
      expect(
        (await call(path, { headers: { authorization: "Bearer nope" } }, env))
          ?.status,
      ).toBe(401);
    }
    expect(seen).toHaveLength(0);
  });

  it("reads state without the sandbox id, events and evidence with the token", async () => {
    const { env, seen } = setup((s) =>
      s.url.includes("evidence")
        ? new Response("png", { headers: { "content-type": "image/png" } })
        : Response.json({ id: "r1", phase: "brief", sandboxId: "sb_1" }),
    );
    const get = (path: string) => call(path, { headers: operator }, env);
    const state = await get("/api/v1/runs/r1");
    expect(state?.status).toBe(200);
    expect(await state?.json()).toEqual({ id: "r1", phase: "brief" });
    expect((await get("/api/v1/runs/r1/events?since=7"))?.status).toBe(200);
    const shot = await get("/api/v1/runs/r1/evidence/ev_001");
    expect(shot?.headers.get("content-type")).toBe("image/png");
    expect(await shot?.text()).toBe("png");
    // Captured site content must never run on this origin.
    expect(shot?.headers.get("content-security-policy")).toContain("sandbox");
    expect(shot?.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await get("/api/v1/runs/r1/events?since=x"))?.status).toBe(400);
    expect((await get("/api/v1/runs/r1/evidence/../x"))?.status).toBe(404);
    expect(seen.map((s) => s.url)).toEqual([
      "https://orchestrator/runs/r1",
      "https://orchestrator/runs/r1/events?since=7",
      "https://orchestrator/runs/r1/evidence/ev_001",
    ]);
  });

  it("drops the sandbox id from events and action replies", async () => {
    const preview = {
      seq: 9,
      ts: "2026-10-16T12:00:00Z",
      type: "preview",
      data: { url: "https://4173-sb.daytona.app", sandboxId: "sb_1" },
    };
    const { env } = setup((s) =>
      s.url.includes("events")
        ? Response.json([preview])
        : Response.json({ id: "r1", phase: "building", sandboxId: "sb_1" }),
    );
    const events = await call(
      "/api/v1/runs/r1/events?since=8",
      { headers: operator },
      env,
    );
    expect(await events?.json()).toEqual([
      { ...preview, data: { url: "https://4173-sb.daytona.app" } },
    ]);
    const built = await call(
      "/api/v1/runs/r1/build",
      { method: "POST", headers: operator },
      env,
    );
    expect(await built?.json()).toEqual({ id: "r1", phase: "building" });
  });

  it.each(["/api/v1/runs", "/api/v1/orchestrator/runs"])(
    "preserves JSON evidence bytes through %s",
    async (prefix) => {
      const bytes = new TextEncoder().encode(
        '{\n  "sandboxId": "string", "nested": {"sandboxId": "number"}\n}\n',
      );
      const { env } = setup(
        () =>
          new Response(bytes, {
            headers: {
              "content-type": "application/json",
              "access-control-allow-origin": "*",
            },
          }),
      );
      const response = await call(
        `${prefix}/r1/evidence/ev_001`,
        { headers: operator },
        env,
      );
      expect(response?.status).toBe(200);
      expect(new Uint8Array(await response!.arrayBuffer())).toEqual(bytes);
      expect(response?.headers.get("content-type")).toBe("application/json");
      expect(response?.headers.get("content-security-policy")).toContain(
        "sandbox",
      );
      expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response?.headers.get("access-control-allow-origin")).toBeNull();
    },
  );

  it("answers 404 for a run the orchestrator does not know", async () => {
    const { env } = setup(() => new Response(undefined, { status: 200 }));
    const response = await call(
      "/api/v1/runs/missing",
      { headers: operator },
      env,
    );
    expect(response?.status).toBe(404);
    expect(await response?.json()).toMatchObject({ code: "run_not_found" });
  });

  it("passes the orchestrator's reason through when it refuses", async () => {
    const reason = "No build started: tasks appear after the spec is approved.";
    const { env } = setup(() =>
      Response.json({ error: reason }, { status: 500 }),
    );
    const response = await call(
      "/api/v1/runs/r1/build",
      { method: "POST", headers: operator },
      env,
    );
    expect(response?.status).toBe(502);
    expect(await response?.json()).toMatchObject({
      code: "orchestrator_error",
      message: reason,
    });
  });
});

it("validates and forwards report edits behind the existing operator gate", async () => {
  const { env, seen } = setup();
  const path = "/api/v1/runs/report-run/report-edit";
  const json = { figureId: "f1", edit: { label: "User label", value: "580" } };
  expect((await call(path, { method: "POST", json }, env))?.status).toBe(401);
  expect(seen).toHaveLength(0);
  expect(
    (await call(path, { method: "POST", headers: operator, json }, env))
      ?.status,
  ).toBe(200);
  expect(seen[0]?.url).toBe("https://orchestrator/runs/report-run/report-edit");
  expect(JSON.parse(seen[0]?.body ?? "")).toEqual(json);
  expect(
    (
      await call(
        path,
        {
          method: "POST",
          headers: operator,
          json: { ...json, edit: { label: "", value: "1" } },
        },
        env,
      )
    )?.status,
  ).toBe(400);
  expect(seen).toHaveLength(1);
});
