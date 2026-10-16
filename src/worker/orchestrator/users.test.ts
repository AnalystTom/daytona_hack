import { describe, expect, it, vi } from "vitest";
import { AUD, accessJwt, certs, TEAM } from "./access-fixtures";
import { handleOrchestrator, type OrchestratorEnv } from "./front";
import type { Owners, RunOwner } from "./owners";

const SITE = "https://reversy.test";

// The SurrealDB owner store's behaviour, in memory.
function memoryOwners(): Owners {
  const runs: (RunOwner & { active: boolean })[] = [];
  const counts = new Map<string, number>();
  return {
    async get(runId) {
      return runs.find((r) => r.runId === runId) ?? null;
    },
    async list(owner, since) {
      return runs
        .filter((r) => r.owner === owner && r.createdAt > since)
        .reverse();
    },
    async reserve(run, maxActive, perDay, ended) {
      const active = runs.filter(
        (r) => r.owner === run.owner && r.active && !ended.includes(r.runId),
      );
      if (active.length >= maxActive) return "active_run_limit";
      const key = `${run.owner} ${new Date(run.createdAt).toISOString().slice(0, 10)}`;
      if ((counts.get(key) ?? 0) >= perDay) return "daily_run_limit";
      for (const r of runs)
        if (r.owner === run.owner && ended.includes(r.runId)) r.active = false;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      runs.push({ ...run, active: true });
      return undefined;
    },
  };
}

// A stand-in orchestrator that keeps each run's phase; it never starts anything real.
function setup(
  vars: Partial<OrchestratorEnv> = {},
  onStart?: (id: string) => Promise<Response | void>,
) {
  const phases = new Map<string, string>();
  const pending = new Map<string, string>();
  let onStop: (() => Promise<Response>) | undefined;
  const calls: string[] = [];
  const fetcher = {
    async fetch(input: string, init: RequestInit = {}) {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.method === "POST" && path === "/runs") {
        const body = (await request.json()) as { id?: string };
        const id = body.id ?? crypto.randomUUID();
        phases.set(id, "brief");
        const failure = await onStart?.(id);
        return (
          failure ?? Response.json({ id, phase: "brief" }, { status: 201 })
        );
      }
      const [, , id = "", action] = path.split("/");
      if (!phases.has(id)) return new Response("");
      if (action === "stop") {
        if (onStop) return onStop();
        phases.set(id, "stopped");
        pending.delete(id);
      }
      return Response.json({
        id,
        phase: phases.get(id),
        pending: pending.get(id),
      });
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
  return {
    as,
    start,
    phases,
    pending,
    calls,
    env,
    owners,
    setStop: (handler: () => Promise<Response>) => {
      onStop = handler;
    },
  };
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
    const { id } = (await created.json()) as { id: string };
    const read = await as("ada@example.com", "GET", `/api/v1/runs/${id}`);
    expect(read.status).toBe(200);
    const list = await as("ada@example.com", "GET", "/api/v1/runs");
    expect(await list.json()).toEqual([{ id, createdAt: expect.any(String) }]);
  });

  it("cannot see or touch another user's run", async () => {
    const { as, start, calls } = setup();
    const { id } = (await (await start("ada@example.com")).json()) as {
      id: string;
    };
    const before = calls.length;
    for (const [method, path] of [
      ["GET", `/api/v1/runs/${id}`],
      ["GET", `/api/v1/runs/${id}/events?since=0`],
      ["GET", `/api/v1/runs/${id}/preview`],
      ["GET", `/api/v1/runs/${id}/evidence/ev_1`],
      ["POST", `/api/v1/runs/${id}/messages`],
      ["POST", `/api/v1/runs/${id}/override`],
      ["POST", `/api/v1/runs/${id}/build`],
      ["POST", `/api/v1/runs/${id}/approve`],
      ["POST", `/api/v1/runs/${id}/stop`],
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
    const first = await start("ada@example.com");
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    const second = await start("ada@example.com");
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: "active_run_limit" });
    // Another user is not held back by Ada's run.
    expect((await start("bob@example.com")).status).toBe(201);
    // Once Ada's run stops she can start another.
    await as("ada@example.com", "POST", `/api/v1/runs/${id}/stop`);
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

  it.each(["brief", "building", "done", "failed", "stopped"])(
    "holds admission for a %s run with pending cancellation, even after expiry",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const { start, phases, pending, calls } = setup();
        const { id } = (await (await start("ada@example.com")).json()) as {
          id: string;
        };
        phases.set(id, phase);
        pending.set(id, "stop");
        vi.setSystemTime(Date.now() + 121 * 60_000);
        expect((await start("ada@example.com")).status).toBe(429);
        expect(calls.filter((c) => c === "POST /runs")).toHaveLength(1);
        pending.delete(id);
        phases.set(id, "stopped");
        expect((await start("ada@example.com")).status).toBe(201);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["pending", "failed", "unconfirmed"])(
    "does not release expired admission after a %s cancellation response",
    async (outcome) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const { start, phases, setStop, calls } = setup();
        const { id } = (await (await start("ada@example.com")).json()) as {
          id: string;
        };
        phases.set(id, "building");
        vi.setSystemTime(Date.now() + 121 * 60_000);
        setStop(async () =>
          outcome === "failed"
            ? Response.json({ error: "cancellation failed" }, { status: 500 })
            : Response.json({
                phase: outcome === "pending" ? "stopped" : "building",
                pending: outcome === "pending" ? "stop" : undefined,
              }),
        );
        const second = await start("ada@example.com");
        expect(second.status).toBe(outcome === "failed" ? 502 : 429);
        expect(calls.filter((c) => c === "POST /runs")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("disables bearer, old cookies, session creation and the operator proxy in Access mode", async () => {
    const { as, env, calls } = setup();
    const fallback = {
      ...env,
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
    };
    const login = await handleOrchestrator(
      new Request(`${SITE}/api/v1/session`, {
        method: "POST",
        headers: { origin: SITE },
        body: JSON.stringify({ token: "operator-secret" }),
      }),
      fallback,
    );
    const cookie = login!.headers.get("set-cookie")!.split(";")[0]!;
    for (const headers of [
      { authorization: "Bearer operator-secret" },
      { cookie },
    ]) {
      const response = await handleOrchestrator(
        new Request(`${SITE}/api/v1/runs/r1`, { headers }),
        env,
      );
      expect(response?.status).toBe(401);
      expect(await response?.json()).toMatchObject({ code: "access_required" });
    }
    expect(
      (
        await as("operator", "POST", "/api/v1/session", {
          token: "operator-secret",
        })
      ).status,
    ).toBe(401);
    expect(
      (await as("operator", "GET", "/api/v1/orchestrator/runs/r1")).status,
    ).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("reserves one active slot while two starts overlap, including across midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-16T23:59:59Z"));
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { start, calls } = setup({}, async () => {
        entered();
        await blocked;
      });
      const first = start("ada@example.com");
      await started;
      vi.setSystemTime(new Date("2026-10-17T00:00:01Z"));
      const second = await start("ada@example.com");
      release();
      expect((await first).status).toBe(201);
      expect(second.status).toBe(429);
      expect(await second.json()).toMatchObject({ code: "active_run_limit" });
      expect(calls.filter((c) => c === "POST /runs")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps paid failures owned, stoppable and charged against the daily allowance", async () => {
    let paid = 0;
    const { start, as, owners } = setup({ RUNS_PER_DAY: "1" }, async (id) => {
      expect((await owners.get(id))?.owner).toBe("ada@example.com");
      paid++;
      return Response.json(
        { error: "model failed after capture" },
        { status: 500 },
      );
    });
    expect((await start("ada@example.com")).status).toBe(502);
    const list = await as("ada@example.com", "GET", "/api/v1/runs");
    const rows = (await list.json()) as { id: string }[];
    const id = rows[0]!.id;
    expect(
      (await as("ada@example.com", "GET", `/api/v1/runs/${id}`)).status,
    ).toBe(200);
    expect(
      (await as("ada@example.com", "POST", `/api/v1/runs/${id}/stop`)).status,
    ).toBe(200);
    const second = await start("ada@example.com");
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: "daily_run_limit" });
    expect(paid).toBe(1);
  });

  it("does not call a paid start if durable admission fails", async () => {
    const { start, owners, calls } = setup();
    owners.reserve = async () => {
      throw new Error("storage unavailable");
    };
    expect((await start("ada@example.com")).status).toBe(500);
    expect(calls).toHaveLength(0);
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
    expect(
      (
        await as("operator", "POST", "/api/v1/runs", {
          url: "https://example.com",
          goal: "Rebuild",
        })
      ).status,
    ).toBe(201);
  });
});
