import { describe, expect, it } from "vitest";
import { handleOrchestrator, type OrchestratorEnv } from "./front";
import { memoryOwners } from "./owners-memory";
import { SESSION_COOKIE } from "./session";

const SITE = "https://reversy.test";
const SECRET = "operator-secret";
const BRIEF = { url: "https://example.com", goal: "copy it" };

// A stand-in for the service binding that keeps each run's phase and records what reaches it.
function setup(vars: Partial<OrchestratorEnv> = {}) {
  const seen: Request[] = [];
  const phases = new Map<string, string>();
  const fetcher = {
    async fetch(input: string, init: RequestInit = {}) {
      const request = new Request(input, init);
      seen.push(request);
      const [, , id = "", action] = new URL(request.url).pathname.split("/");
      if (request.method === "POST" && !id) {
        const body = (await request.json()) as { id: string };
        phases.set(body.id, "brief");
        return Response.json({ id: body.id, phase: "brief" }, { status: 201 });
      }
      if (!phases.has(id)) return new Response("");
      if (action === "stop") phases.set(id, "stopped");
      return Response.json({ id, phase: phases.get(id) });
    },
  } as unknown as Fetcher;
  const env: OrchestratorEnv = {
    ORCHESTRATOR: fetcher,
    OPERATOR_TOKEN: SECRET,
    ...vars,
  };
  const owners = memoryOwners();
  // `cookie` is a visitor's session cookie; omit it for a first visit.
  const call = (
    path: string,
    init: {
      method?: string;
      json?: unknown;
      cookie?: string;
      ip?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const headers: Record<string, string> = {
      origin: SITE,
      "cf-connecting-ip": init.ip ?? "203.0.113.1",
      ...init.headers,
    };
    if (init.cookie) headers.cookie = init.cookie;
    return handleOrchestrator(
      new Request(`${SITE}${path}`, {
        method: init.method,
        headers,
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
      }),
      env,
      { owners },
    ) as Promise<Response>;
  };
  // Starts a run as a fresh visitor, or as the one holding `cookie`.
  const start = async (cookie?: string, ip?: string) => {
    const response = await call("/api/v1/runs", {
      method: "POST",
      json: BRIEF,
      cookie,
      ip,
    });
    return { response, cookie: cookieOf(response) ?? cookie };
  };
  return { seen, call, start, phases };
}

const cookieOf = (response: Response) =>
  response.headers.get("set-cookie")?.split(";")[0];

const idOf = async (response: Response) =>
  ((await response.json()) as { id: string }).id;

// Every route a browser can reach for a run.
const READS = ["", "/events?since=0", "/evidence/ev_001", "/preview"];
const WRITES: [string, unknown][] = [
  ["/messages", { text: "only the hero" }],
  ["/approve", {}],
  ["/build", {}],
  ["/stop", {}],
  ["/override", { taskId: "t1", verdict: "approve" }],
  ["/sign-in", {}],
];

describe("anonymous visitors", () => {
  it("get a signed HttpOnly session cookie when they first start a run, with no token", async () => {
    const { call, start } = setup();
    const browsing = await call("/api/v1/runs");
    expect(browsing.status).toBe(200);
    expect(await browsing.json()).toEqual([]);
    expect(browsing.headers.get("set-cookie")).toBeNull();
    const { response } = await start();
    expect(response.headers.get("set-cookie")).toMatch(
      new RegExp(
        `^${SESSION_COOKIE}=[\\w-]{36}\\.[0-9a-f]{64}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Strict$`,
      ),
    );
  });

  it("keep the same session while they hold the cookie", async () => {
    const { call, start } = setup();
    const { cookie } = await start();
    const again = await call("/api/v1/runs", { cookie });
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("start a run without any token and then own it", async () => {
    const { call, start } = setup();
    const { response, cookie } = await start();
    expect(response.status).toBe(201);
    expect(cookie).toContain(SESSION_COOKIE);
    const id = await idOf(response);
    for (const path of READS) {
      const read = await call(`/api/v1/runs/${id}${path}`, { cookie });
      expect(read.status).toBe(200);
    }
    const list = await call("/api/v1/runs", { cookie });
    expect(await list.json()).toEqual([{ id, createdAt: expect.any(String) }]);
    for (const [path, json] of WRITES) {
      const write = await call(`/api/v1/runs/${id}${path}`, {
        method: "POST",
        json,
        cookie,
      });
      expect(write.status).toBe(200);
    }
  });

  it("cannot read or steer another session's run, and the orchestrator never hears of it", async () => {
    const { call, start, seen } = setup();
    const { response } = await start();
    const id = await idOf(response);
    const before = seen.length;
    const forged = `${SESSION_COOKIE}=${crypto.randomUUID()}.${"0".repeat(64)}`;
    for (const cookie of [undefined, (await start()).cookie, forged]) {
      for (const path of READS) {
        const read = await call(`/api/v1/runs/${id}${path}`, { cookie });
        expect(read.status).toBe(404);
        expect(await read.json()).toMatchObject({ code: "run_not_found" });
      }
      for (const [path, json] of WRITES) {
        const write = await call(`/api/v1/runs/${id}${path}`, {
          method: "POST",
          json,
          cookie,
        });
        expect(write.status).toBe(404);
      }
      const listed = (await (
        await call("/api/v1/runs", { cookie })
      ).json()) as {
        id: string;
      }[];
      expect(listed.map((run) => run.id)).not.toContain(id);
    }
    // Only the other visitor's own start reached the orchestrator.
    expect(seen.slice(before).map((r) => r.method)).toEqual(["POST"]);
  });

  it("are not fooled by another visitor's id with a bad signature", async () => {
    const { call, start } = setup();
    const { response, cookie } = await start();
    const id = await idOf(response);
    const [name, value = ""] = (cookie ?? "").split("=");
    const [visitor = ""] = value.split(".");
    const forged = `${name}=${visitor}.${"1".repeat(64)}`;
    const read = await call(`/api/v1/runs/${id}`, { cookie: forged });
    expect(read.status).toBe(404);
    expect(cookieOf(read)).not.toBe(forged);
  });

  it("write only from our own origin", async () => {
    const { start, seen } = setup();
    const { response, cookie } = await start();
    const id = await idOf(response);
    const before = seen.length;
    for (const origin of [undefined, "https://evil.test"]) {
      for (const [path, json] of [
        ["/api/v1/runs", BRIEF],
        [`/api/v1/runs/${id}/stop`, {}],
      ] as const) {
        const write = await handleOrchestrator(
          new Request(`${SITE}${path}`, {
            method: "POST",
            headers: origin
              ? { cookie: cookie ?? "", origin }
              : { cookie: cookie ?? "" },
            body: JSON.stringify(json),
          }),
          { ORCHESTRATOR: {} as Fetcher, OPERATOR_TOKEN: SECRET },
        );
        expect(write?.status).toBe(403);
      }
    }
    expect(seen).toHaveLength(before);
  });

  it("never see the operator token", async () => {
    const { call, start } = setup();
    const { response, cookie } = await start();
    const id = await idOf(response.clone());
    const replies = [
      response,
      await call("/api/v1/runs", { cookie }),
      await call(`/api/v1/runs/${id}`, { cookie }),
      await call(`/api/v1/runs/${id}`),
      await call("/api/v1/session", {
        method: "POST",
        json: { token: SECRET },
      }),
    ];
    for (const reply of replies.filter(Boolean)) {
      const text =
        JSON.stringify([...(reply?.headers ?? [])]) + (await reply?.text());
      expect(text).not.toContain(SECRET);
    }
  });

  it("have no token-to-session endpoint any more", async () => {
    const env = { ORCHESTRATOR: {} as Fetcher, OPERATOR_TOKEN: SECRET };
    const response = await handleOrchestrator(
      new Request(`${SITE}/api/v1/session`, {
        method: "POST",
        headers: { origin: SITE },
        body: JSON.stringify({ token: SECRET }),
      }),
      env,
    );
    expect(response).toBeNull();
  });
});

describe("run limits", () => {
  it("allow three runs per session per day by default, then say so", async () => {
    const { start, phases } = setup({ ACTIVE_RUNS: "10" });
    let cookie: string | undefined;
    for (let i = 0; i < 3; i++) {
      const started = await start(cookie);
      expect(started.response.status).toBe(201);
      cookie = started.cookie;
    }
    const fourth = await start(cookie);
    expect(fourth.response.status).toBe(429);
    expect(await fourth.response.json()).toMatchObject({
      code: "daily_run_limit",
      message: "You have reached today's run limit. Try again tomorrow (UTC).",
    });
    expect(phases.size).toBe(3);
  });

  it("allow one active run per session", async () => {
    const { start, call } = setup();
    const first = await start();
    const second = await start(first.cookie);
    expect(second.response.status).toBe(429);
    expect(await second.response.json()).toMatchObject({
      code: "active_run_limit",
      message: expect.stringContaining("Stop an active run"),
    });
    await call(`/api/v1/runs/${await idOf(first.response)}/stop`, {
      method: "POST",
      json: {},
      cookie: first.cookie,
    });
    expect((await start(first.cookie)).response.status).toBe(201);
  });

  it("allow six runs per network address per day by default, whatever the session", async () => {
    const { start } = setup({ RUNS_PER_DAY_ALL: "100" });
    for (let i = 0; i < 6; i++) {
      expect((await start()).response.status).toBe(201);
    }
    const seventh = await start();
    expect(seventh.response.status).toBe(429);
    expect(await seventh.response.json()).toMatchObject({
      code: "ip_daily_limit",
      message: expect.stringContaining("your network"),
    });
    expect((await start(undefined, "203.0.113.2")).response.status).toBe(201);
  });

  it("cap new runs across all visitors, thirty a day by default", async () => {
    const { start } = setup({ RUNS_PER_IP_DAY: "100" });
    for (let i = 0; i < 30; i++) {
      expect((await start()).response.status).toBe(201);
    }
    const next = await start();
    expect(next.response.status).toBe(429);
    expect(await next.response.json()).toMatchObject({
      code: "global_daily_limit",
      message: expect.stringContaining("Reversy has reached its run limit"),
    });
  });

  it("take the limits from Worker variables", async () => {
    const { start } = setup({ RUNS_PER_DAY_ALL: "1" });
    expect((await start()).response.status).toBe(201);
    expect((await start(undefined, "203.0.113.9")).response.status).toBe(429);
  });

  it("do not count a start the user got wrong", async () => {
    const { call, start } = setup({ RUNS_PER_DAY_ALL: "1" });
    const bad = await call("/api/v1/runs", {
      method: "POST",
      json: { url: "http://localhost", goal: "x" },
    });
    expect(bad.status).toBe(400);
    expect((await start()).response.status).toBe(201);
  });
});

describe("operators", () => {
  it("still need the token for the operator route, which never sees a visitor cookie", async () => {
    const { call, start, seen } = setup();
    const { cookie } = await start();
    expect(
      (await call("/api/v1/orchestrator/runs/r1", { cookie })).status,
    ).toBe(401);
    const before = seen.length;
    const ok = await call("/api/v1/orchestrator/runs/r1", {
      cookie,
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(ok.status).toBe(200);
    expect(seen.slice(before)).toHaveLength(1);
    expect(seen.at(-1)?.headers.get("cookie")).toBeNull();
  });

  it("can still use run routes with the bearer token, but not from another site", async () => {
    const { call, start } = setup();
    const id = await idOf((await start()).response);
    const bearer = { authorization: `Bearer ${SECRET}` };
    const read = await call(`/api/v1/runs/${id}`, { headers: bearer });
    expect(read.status).toBe(200);
    expect(read.headers.get("set-cookie")).toBeNull();
    const foreign = await call(`/api/v1/runs/${id}/stop`, {
      method: "POST",
      json: {},
      headers: { ...bearer, origin: "https://evil.test" },
    });
    expect(foreign.status).toBe(403);
    const wrong = await call(`/api/v1/runs/${id}`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  });

  it("fail closed when the worker has no secret to sign visitor sessions", async () => {
    const { call } = setup({ OPERATOR_TOKEN: undefined });
    expect((await call("/api/v1/runs")).status).toBe(503);
  });
});
