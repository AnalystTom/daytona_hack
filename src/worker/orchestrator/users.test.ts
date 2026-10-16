import { describe, expect, it, vi } from "vitest";
import { AUD, accessJwt, certs, TEAM } from "./access-fixtures";
import { handleOrchestrator, type OrchestratorEnv } from "./front";
import type { Owners, RunOwner } from "./owners";

const SITE = "https://reversy.test";

// The SurrealDB owner store's behaviour, in memory.
function memoryOwners(): Owners {
  const runs: RunOwner[] = [];
  const counts = new Map<string, number>();
  return {
    async get(runId) {
      return runs.find((r) => r.runId === runId) ?? null;
    },
    async claim(runId, owner, createdAt) {
      runs.push({ runId, owner, createdAt });
    },
    async list(owner, since) {
      return runs
        .filter((r) => r.owner === owner && r.createdAt > since)
        .reverse();
    },
    async count(owner, day, by) {
      const key = `${owner} ${day}`;
      counts.set(key, (counts.get(key) ?? 0) + by);
      return counts.get(key) as number;
    },
  };
}

// A stand-in orchestrator that keeps each run's phase; it never starts anything real.
function setup(vars: Partial<OrchestratorEnv> = {}) {
  const phases = new Map<string, string>();
  const calls: string[] = [];
  const fetcher = {
    async fetch(input: string, init: RequestInit = {}) {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.method === "POST" && path === "/runs") {
        const id = `r${phases.size + 1}`;
        phases.set(id, "brief");
        return Response.json({ id, phase: "brief" }, { status: 201 });
      }
      const [, , id = "", action] = path.split("/");
      if (!phases.has(id)) return new Response("");
      if (action === "stop") phases.set(id, "stopped");
      return Response.json({ id, phase: phases.get(id) });
    },
  } as unknown as Fetcher;
  const env: OrchestratorEnv = {
    ORCHESTRATOR: fetcher,
    OPERATOR_TOKEN: "operator-secret",
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ...vars,
  };
  const owners = memoryOwners();
  // `email` signs in through Access; "operator" sends the operator token instead.
  const as = async (
    email: string | null,
    method: string,
    path: string,
    json?: unknown,
  ) => {
    const headers: Record<string, string> = { origin: SITE };
    if (email === "operator") headers.authorization = "Bearer operator-secret";
    else if (email) {
      headers["cf-access-jwt-assertion"] = await accessJwt({ email });
    }
    if (json !== undefined) headers["content-type"] = "application/json";
    return handleOrchestrator(
      new Request(`${SITE}${path}`, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
      }),
      env,
      { owners, fetcher: certs },
    ) as Promise<Response>;
  };
  const start = (email: string) =>
    as(email, "POST", "/api/v1/runs", {
      url: "https://example.com",
      goal: "Rebuild it",
    });
  return { as, start, phases, calls };
}

describe("Cloudflare Access users", () => {
  it("need a valid sign-in: no token box, no JWT means 401", async () => {
    const { as, calls } = setup();
    const missing = await as(null, "GET", "/api/v1/runs/r1/events");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({
      message: expect.stringContaining("Cloudflare Access"),
    });
    expect(calls).toHaveLength(0);
  });

  it("start a run without the operator token and own it", async () => {
    const { as, start } = setup();
    const created = await start("ada@example.com");
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: "r1" });
    const read = await as("ada@example.com", "GET", "/api/v1/runs/r1");
    expect(read.status).toBe(200);
    const list = await as("ada@example.com", "GET", "/api/v1/runs");
    expect(await list.json()).toEqual([
      { id: "r1", createdAt: expect.any(String) },
    ]);
  });

  it("cannot see or touch another user's run", async () => {
    const { as, start, calls } = setup();
    await start("ada@example.com");
    const before = calls.length;
    for (const [method, path] of [
      ["GET", "/api/v1/runs/r1"],
      ["GET", "/api/v1/runs/r1/events?since=0"],
      ["GET", "/api/v1/runs/r1/preview"],
      ["POST", "/api/v1/runs/r1/stop"],
    ] as const) {
      const response = await as("bob@example.com", method, path);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "run_not_found" });
    }
    expect(calls.length).toBe(before);
    const list = await as("bob@example.com", "GET", "/api/v1/runs");
    expect(await list.json()).toEqual([]);
  });

  it("can have one active run at a time by default", async () => {
    const { as, start } = setup();
    expect((await start("ada@example.com")).status).toBe(201);
    const second = await start("ada@example.com");
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: "active_run_limit" });
    // Another user is not held back by Ada's run.
    expect((await start("bob@example.com")).status).toBe(201);
    // Once Ada's run stops she can start another.
    await as("ada@example.com", "POST", "/api/v1/runs/r1/stop");
    expect((await start("ada@example.com")).status).toBe(201);
  });

  it("can start three runs a day by default", async () => {
    const { start } = setup({ ACTIVE_RUNS: "10" });
    for (let i = 0; i < 3; i++) {
      expect((await start("ada@example.com")).status).toBe(201);
    }
    const fourth = await start("ada@example.com");
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toMatchObject({ code: "daily_run_limit" });
    expect((await start("bob@example.com")).status).toBe(201);
  });

  it("takes limits from Worker variables", async () => {
    const { start } = setup({ RUNS_PER_DAY: "1", ACTIVE_RUNS: "5" });
    expect((await start("ada@example.com")).status).toBe(201);
    expect((await start("ada@example.com")).status).toBe(429);
  });

  it("does not use up a run when the start is refused", async () => {
    const { as, start } = setup({ RUNS_PER_DAY: "1" });
    const bad = await as("ada@example.com", "POST", "/api/v1/runs", {
      url: "http://localhost",
      goal: "x",
    });
    expect(bad.status).toBe(400);
    expect((await start("ada@example.com")).status).toBe(201);
  });

  it("stops counting a run as active once it is past the time limit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { start } = setup({ RUN_MAX_MINUTES: "30" });
      expect((await start("ada@example.com")).status).toBe(201);
      vi.setSystemTime(Date.now() + 29 * 60_000);
      expect((await start("ada@example.com")).status).toBe(429);
      // The orchestrator stops a run at RUN_MAX_MINUTES, so it no longer holds the slot.
      vi.setSystemTime(Date.now() + 2 * 60_000);
      expect((await start("ada@example.com")).status).toBe(201);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the operator token working, without limits or ownership", async () => {
    const { as, start } = setup();
    await start("ada@example.com");
    expect((await as("operator", "GET", "/api/v1/runs/r1")).status).toBe(200);
    const brief = { url: "https://example.com", goal: "Rebuild it" };
    for (let i = 0; i < 5; i++) {
      expect((await as("operator", "POST", "/api/v1/runs", brief)).status).toBe(
        201,
      );
    }
    // Runs the operator starts belong to no Access user.
    expect((await as("ada@example.com", "GET", "/api/v1/runs/r2")).status).toBe(
      404,
    );
  });

  it("behaves as before when Access is not set up", async () => {
    const { as, calls } = setup({
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
    });
    const response = await as("ada@example.com", "GET", "/api/v1/runs/r1");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining("operator token"),
    });
    expect(calls).toHaveLength(0);
  });
});
