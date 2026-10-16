import { afterEach, describe, expect, it, vi } from "vitest";
import { handleOrchestrator } from "./front";
import { SESSION_COOKIE } from "./session";

const SITE = "https://reversy.test";
const SECRET = "operator-secret";

// A stand-in for the service binding that records what reaches the orchestrator.
function setup(token = SECRET) {
  const seen: Request[] = [];
  const fetcher = {
    async fetch(input: string, init: RequestInit = {}) {
      const request = new Request(input, init);
      seen.push(request);
      return request.url.endsWith("/preview")
        ? Response.json({ url: "https://3000-signed.proxy.daytona.works" })
        : Response.json({ id: "r1", phase: "brief" });
    },
  } as unknown as Fetcher;
  return { seen, env: { ORCHESTRATOR: fetcher, OPERATOR_TOKEN: token } };
}

type Env = ReturnType<typeof setup>["env"];

const call = (
  env: Env,
  path: string,
  init: RequestInit & { json?: unknown } = {},
) => {
  const { json, ...rest } = init;
  const body = json === undefined ? rest.body : JSON.stringify(json);
  return handleOrchestrator(
    new Request(`${SITE}${path}`, { ...rest, body }),
    env,
  );
};

async function signIn(env: Env, token = SECRET) {
  const response = await call(env, "/api/v1/session", {
    method: "POST",
    headers: { origin: SITE },
    json: { token },
  });
  const cookie = response?.headers.get("set-cookie") ?? "";
  return { response, cookie, value: cookie.split(";")[0] ?? "" };
}

// Every route a browser can reach for a run, including the event stream and the preview.
const READS = [
  "/api/v1/runs/r1",
  "/api/v1/runs/r1/events?since=0",
  "/api/v1/runs/r1/evidence/ev_001",
  "/api/v1/runs/r1/preview",
];
const WRITES: [string, unknown][] = [
  ["/api/v1/runs", { url: "https://example.com", goal: "copy it" }],
  ["/api/v1/runs/r1/messages", { text: "only the hero" }],
  ["/api/v1/runs/r1/approve", {}],
  ["/api/v1/runs/r1/build", {}],
  ["/api/v1/runs/r1/stop", {}],
  ["/api/v1/runs/r1/override", { taskId: "t1", verdict: "approve" }],
];

afterEach(() => vi.useRealTimers());

describe("session endpoint", () => {
  it("swaps the operator token for a signed HttpOnly cookie", async () => {
    const { env } = setup();
    const { response, cookie, value } = await signIn(env);
    expect(response?.status).toBe(204);
    expect(cookie).toMatch(
      new RegExp(
        `^${SESSION_COOKIE}=\\d+\\.[0-9a-f]{64}; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Strict$`,
      ),
    );
    expect(value).not.toContain(SECRET);
  });

  it("refuses a wrong token, another site and a missing origin", async () => {
    const { env } = setup();
    expect((await signIn(env, "nope")).response?.status).toBe(401);
    for (const headers of <Record<string, string>[]>[
      { origin: "https://evil.test" },
      {},
    ]) {
      const response = await call(env, "/api/v1/session", {
        method: "POST",
        headers,
        json: { token: SECRET },
      });
      expect(response?.status).toBe(403);
      expect(response?.headers.get("set-cookie")).toBeNull();
    }
  });

  it("signs out by expiring the cookie", async () => {
    const { env } = setup();
    const response = await call(env, "/api/v1/session", {
      method: "DELETE",
      headers: { origin: SITE },
    });
    expect(response?.status).toBe(204);
    expect(response?.headers.get("set-cookie")).toMatch(
      new RegExp(`^${SESSION_COOKIE}=; Max-Age=0;`),
    );
  });
});

describe("run routes without a session", () => {
  it("refuse every read, the event stream and the preview", async () => {
    const { env, seen } = setup();
    for (const path of READS) {
      for (const headers of <Record<string, string>[]>[
        {},
        { cookie: `${SESSION_COOKIE}=garbage` },
        { cookie: `${SESSION_COOKIE}=9999999999.${"0".repeat(64)}` },
        { authorization: "Bearer nope" },
      ]) {
        expect((await call(env, path, { headers }))?.status).toBe(401);
      }
    }
    expect(seen).toHaveLength(0);
  });

  it("refuse every write, even from our own origin", async () => {
    const { env, seen } = setup();
    for (const [path, json] of WRITES) {
      const response = await call(env, path, {
        method: "POST",
        headers: { origin: SITE },
        json,
      });
      expect(response?.status).toBe(401);
    }
    expect(seen).toHaveLength(0);
  });
});

describe("run routes with a session", () => {
  it("serve every read, the event stream and the preview link", async () => {
    const { env, seen } = setup();
    const { value } = await signIn(env);
    for (const path of READS) {
      const response = await call(env, path, { headers: { cookie: value } });
      expect(response?.status).toBe(200);
    }
    const preview = await call(env, "/api/v1/runs/r1/preview", {
      headers: { cookie: value },
    });
    expect(await preview?.json()).toEqual({
      url: "https://3000-signed.proxy.daytona.works",
    });
    expect(seen.map((r) => new URL(r.url).pathname)).toContain(
      "/runs/r1/preview",
    );
  });

  it("serve writes only when the request names our origin", async () => {
    const { env, seen } = setup();
    const { value } = await signIn(env);
    for (const [path, json] of WRITES) {
      for (const origin of [undefined, "https://evil.test"]) {
        const response = await call(env, path, {
          method: "POST",
          headers: origin ? { cookie: value, origin } : { cookie: value },
          json,
        });
        expect(response?.status).toBe(403);
      }
    }
    expect(seen).toHaveLength(0);
    for (const [path, json] of WRITES) {
      const response = await call(env, path, {
        method: "POST",
        headers: { cookie: value, origin: SITE },
        json,
      });
      expect(response?.status).toBe(200);
    }
    expect(seen).toHaveLength(WRITES.length);
  });

  it("stop working when the session expires or the token rotates", async () => {
    const { env } = setup();
    const { value } = await signIn(env);
    const rotated = setup("rotated-secret").env;
    expect(
      (await call(rotated, "/api/v1/runs/r1", { headers: { cookie: value } }))
        ?.status,
    ).toBe(401);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 13 * 60 * 60 * 1000);
    expect(
      (await call(env, "/api/v1/runs/r1", { headers: { cookie: value } }))
        ?.status,
    ).toBe(401);
  });

  it("refuse a forged signature", async () => {
    const { env } = setup();
    const { value } = await signIn(env);
    const forged = value.replace(/\.[0-9a-f]/, (m) =>
      m === ".0" ? ".1" : ".0",
    );
    expect(
      (await call(env, "/api/v1/runs/r1", { headers: { cookie: forged } }))
        ?.status,
    ).toBe(401);
  });
});

describe("bearer callers", () => {
  it("still work without an origin, but not from another site", async () => {
    const { env } = setup();
    const bearer = { authorization: `Bearer ${SECRET}` };
    expect(
      (
        await call(env, "/api/v1/runs/r1/stop", {
          method: "POST",
          headers: bearer,
        })
      )?.status,
    ).toBe(200);
    expect(
      (
        await call(env, "/api/v1/runs/r1/stop", {
          method: "POST",
          headers: { ...bearer, origin: "https://evil.test" },
        })
      )?.status,
    ).toBe(403);
  });

  it("keep operator testing bearer-only and never forward the cookie", async () => {
    const { env, seen } = setup();
    const { value } = await signIn(env);
    expect(
      (
        await call(env, "/api/v1/orchestrator/runs/r1", {
          headers: { cookie: value },
        })
      )?.status,
    ).toBe(401);
    await call(env, "/api/v1/orchestrator/runs/r1", {
      headers: { cookie: value, authorization: `Bearer ${SECRET}` },
    });
    expect(seen[0]?.headers.get("cookie")).toBeNull();
  });
});
