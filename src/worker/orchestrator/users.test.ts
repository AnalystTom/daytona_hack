import { assert, describe, expect, it, vi } from "vitest";
import { AUD, accessJwt, certs, TEAM } from "./access-fixtures";
import { handleOrchestrator, type OrchestratorEnv } from "./front";
import { memoryOwners } from "./owners-memory";
import { SESSION_COOKIE } from "./session";
import { StoreError } from "../store/types";

const SITE = "https://reversy.test";

// A stand-in orchestrator that keeps each run's phase; it never starts anything real.
function setup(
  vars: Partial<OrchestratorEnv> = {},
  onStart?: (id: string) => Promise<Response> | Promise<void>,
) {
  const phases = new Map<string, string>();
  const pending = new Map<string, string>();
  let onStop: (() => Promise<Response>) | undefined;
  let onAction: ((id: string, action: string) => Promise<void>) | undefined;
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
      if (
        request.method === "POST" &&
        action !== undefined &&
        ["messages", "override", "approve", "build", "sign-in"].includes(action)
      )
        await onAction?.(id, action);
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
    const headers: Record<string, string> = {
      origin: SITE,
      "cf-connecting-ip": "203.0.113.1",
    };
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
    setAction: (handler: (id: string, action: string) => Promise<void>) => {
      onAction = handler;
    },
    setStop: (handler: () => Promise<Response>) => {
      onStop = handler;
    },
  };
}

describe("in-memory admission contract", () => {
  it("commits ended runs on daily refusal and retains active runs across days", async () => {
    const owners = memoryOwners();
    const first = {
      runId: "first",
      owner: "ada@example.com",
      createdAt: Date.UTC(2026, 9, 16),
    };
    expect(await owners.reserve(first, 1, 1, [])).toBeUndefined();
    expect(
      await owners.reserve({ ...first, runId: "refused" }, 1, 1, [first]),
    ).toBe("daily_run_limit");
    const next = {
      ...first,
      runId: "next",
      createdAt: first.createdAt + 86_400_000,
    };
    expect(await owners.reserve(next, 1, 1, [])).toBeUndefined();
    expect(
      await owners.reserve(
        { ...next, runId: "blocked", createdAt: next.createdAt + 86_400_000 },
        1,
        1,
        [],
      ),
    ).toBe("active_run_limit");
  });
});

describe("Cloudflare Access users", () => {
  it("cannot start paid work without a client IP even with valid Access identity", async () => {
    const { env, owners, calls } = setup();
    const response = await handleOrchestrator(
      new Request(`${SITE}/api/v1/runs`, {
        method: "POST",
        headers: {
          origin: SITE,
          "cf-access-jwt-assertion": await accessJwt({
            email: "ada@example.com",
          }),
        },
        body: JSON.stringify({
          url: "https://example.com",
          goal: "Rebuild it",
        }),
      }),
      env,
      { owners, fetcher: certs },
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      code: "client_ip_required",
    });
    expect(calls).toHaveLength(0);
    expect(await owners.list("ada@example.com", 0)).toEqual([]);
  });

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
      ["POST", `/api/v1/runs/${id}/sign-in`],
      ["POST", `/api/v1/runs/${id}/sign-in/resume`],
      ["POST", `/api/v1/runs/${id}/sign-in/skip`],
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
    "holds pending cancellation for a %s run until deadline recovery confirms stop",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const { start, phases, pending, calls, setStop } = setup();
        const { id } = (await (await start("ada@example.com")).json()) as {
          id: string;
        };
        phases.set(id, phase);
        pending.set(id, "stop");
        vi.setSystemTime(Date.now() + 119 * 60_000);
        expect((await start("ada@example.com")).status).toBe(429);
        expect(calls.filter((c) => c === "POST /runs")).toHaveLength(1);
        setStop(async () =>
          Response.json({ phase: "stopped", pending: "stop" }),
        );
        vi.setSystemTime(Date.now() + 60_000);
        expect((await start("ada@example.com")).status).toBe(429);
        pending.delete(id);
        phases.set(id, "stopped");
        setStop(async () => Response.json({ phase: "stopped" }));
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

  it("re-admits completed chat and overrides without changing identity or daily accounting", async () => {
    const { start, as, phases, owners, setAction, calls } = setup({
      RUNS_PER_DAY: "3",
    });
    const a = (await (await start("ada@example.com")).json()) as { id: string };
    const original = await owners.get(a.id);
    assert(original);
    phases.set(a.id, "done");
    const b = (await (await start("ada@example.com")).json()) as { id: string };
    let paid = 0;
    setAction(async () => {
      paid++;
    });
    for (const [action, body] of [
      ["messages", { text: "Make a variant" }],
      ["sign-in", {}],
      ["sign-in/resume", {}],
      ["sign-in/skip", {}],
      ["override", { taskId: "t01", verdict: "approve", reason: "Continue" }],
      ["override", { taskId: "t01", verdict: "reject", reason: "Retry" }],
    ] as const) {
      const refused = await as(
        "ada@example.com",
        "POST",
        `/api/v1/runs/${a.id}/${action}`,
        body,
      );
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ code: "active_run_limit" });
    }
    expect(paid).toBe(0);
    await as("ada@example.com", "POST", `/api/v1/runs/${b.id}/stop`);
    let release!: () => void;
    let entered!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    setAction(async () => {
      paid++;
      entered();
      await blocked;
    });
    const continuing = as(
      "ada@example.com",
      "POST",
      `/api/v1/runs/${a.id}/messages`,
      { text: "Make a variant" },
    );
    await began;
    expect((await start("ada@example.com")).status).toBe(429);
    expect(
      (
        await as("ada@example.com", "POST", `/api/v1/runs/${a.id}/override`, {
          taskId: "t01",
          verdict: "approve",
        })
      ).status,
    ).toBe(429);
    release();
    expect((await continuing).status).toBe(200);
    expect(await owners.get(a.id)).toMatchObject({
      runId: a.id,
      owner: original.owner,
      createdAt: original.createdAt,
      busy: false,
    });
    setAction(async (id, action) => {
      paid++;
      if (action === "override") phases.set(id, "building");
    });
    expect(
      (
        await as("ada@example.com", "POST", `/api/v1/runs/${a.id}/override`, {
          taskId: "t01",
          verdict: "approve",
        })
      ).status,
    ).toBe(200);
    expect((await start("ada@example.com")).status).toBe(429);
    phases.set(a.id, "done");
    const third = await start("ada@example.com");
    expect(third.status).toBe(201);
    expect(paid).toBe(2);
    expect(calls.filter((c) => c === "POST /runs")).toHaveLength(3);
  });

  it("does not retire a resumed run using a concurrent start's stale completion snapshot", async () => {
    const { start, as, phases, owners, setAction, calls } = setup();
    const { id } = (await (await start("ada@example.com")).json()) as {
      id: string;
    };
    phases.set(id, "done");
    const reserve = owners.reserve;
    let release!: () => void;
    let entered!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    owners.reserve = async (run, ...args) => {
      if (run.runId !== id) {
        entered();
        await blocked;
      }
      return reserve(run, ...args);
    };
    const competing = start("ada@example.com");
    await began;
    let paid = 0;
    setAction(async () => {
      paid++;
      phases.set(id, "building");
    });
    expect(
      (
        await as("ada@example.com", "POST", `/api/v1/runs/${id}/override`, {
          taskId: "t01",
          verdict: "reject",
        })
      ).status,
    ).toBe(200);
    release();
    expect((await competing).status).toBe(429);
    expect(paid).toBe(1);
    expect(calls.filter((c) => c === "POST /runs")).toHaveLength(1);
  });

  it("releases a failed continuation without extending its original deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { start, as, phases, owners, setAction } = setup({
        RUNS_PER_DAY: "2",
        RUN_MAX_MINUTES: "30",
      });
      const { id } = (await (await start("ada@example.com")).json()) as {
        id: string;
      };
      phases.set(id, "done");
      let paid = 0;
      setAction(async () => {
        paid++;
        throw new Error("paid provider failed");
      });
      expect(
        (
          await as("ada@example.com", "POST", `/api/v1/runs/${id}/messages`, {
            text: "Continue",
          })
        ).status,
      ).toBe(500);
      expect(await owners.get(id)).toMatchObject({ busy: false });
      vi.setSystemTime(Date.now() + 30 * 60_000);
      expect(
        (
          await as("ada@example.com", "POST", `/api/v1/runs/${id}/override`, {
            taskId: "t01",
            verdict: "approve",
          })
        ).status,
      ).toBe(409);
      expect(paid).toBe(1);
      expect((await start("ada@example.com")).status).toBe(201);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers failed continuation cleanup only after the original deadline and confirmed cancellation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
      const { start, as, phases, pending, owners, setAction, setStop, calls } =
        setup({ RUNS_PER_DAY: "2", RUN_MAX_MINUTES: "30" });
      const { id } = (await (await start("ada@example.com")).json()) as {
        id: string;
      };
      const original = await owners.get(id);
      assert(original);
      const finish = owners.finish;
      let storageUnavailable = true;
      owners.finish = async (...args) => {
        if (storageUnavailable) throw new StoreError("cleanup unavailable");
        return finish(...args);
      };
      let paid = 0;
      setAction(async () => {
        paid++;
      });
      expect(
        (
          await as("ada@example.com", "POST", `/api/v1/runs/${id}/messages`, {
            text: "Continue",
          })
        ).status,
      ).toBe(503);
      const abandoned = await owners.get(id);
      assert(abandoned);
      expect(abandoned).toMatchObject({
        runId: id,
        createdAt: original.createdAt,
        busy: true,
        active: true,
      });
      expect((await start("ada@example.com")).status).toBe(429);
      expect(
        (
          await as("ada@example.com", "POST", `/api/v1/runs/${id}/messages`, {
            text: "Continue",
          })
        ).status,
      ).toBe(429);
      expect(paid).toBe(1);
      expect(calls.filter((c) => c === "POST /runs")).toHaveLength(1);
      expect(
        (await as("ada@example.com", "GET", `/api/v1/runs/${id}`)).status,
      ).toBe(200);
      const history = await as("ada@example.com", "GET", "/api/v1/runs");
      expect(await history.json()).toEqual([
        { id, createdAt: new Date(original.createdAt).toISOString() },
      ]);
      let stopFails = true;
      setStop(async () => {
        pending.set(id, "stop");
        if (stopFails)
          return Response.json(
            { error: "cancellation unavailable" },
            { status: 503 },
          );
        phases.set(id, "stopped");
        pending.delete(id);
        return Response.json({ phase: "stopped" });
      });
      vi.setSystemTime(original.createdAt + 30 * 60_000);
      const cancellationFailure = await start("ada@example.com");
      expect(cancellationFailure.status).toBe(502);
      expect(await cancellationFailure.json()).toMatchObject({
        message: "cancellation unavailable",
      });
      expect(await owners.get(id)).toMatchObject({ busy: true, active: true });
      stopFails = false;
      expect((await start("ada@example.com")).status).toBe(503);
      expect(await owners.get(id)).toMatchObject({ busy: true, active: true });
      storageUnavailable = false;
      const recovered = await start("ada@example.com");
      expect(recovered.status).toBe(201);
      const next = (await recovered.json()) as { id: string };
      expect(await owners.get(id)).toMatchObject({
        runId: id,
        owner: original.owner,
        createdAt: original.createdAt,
        revision: abandoned.revision,
        busy: false,
        active: false,
      });
      phases.set(next.id, "done");
      const daily = await start("ada@example.com");
      expect(daily.status).toBe(429);
      expect(await daily.json()).toMatchObject({ code: "daily_run_limit" });
      expect(
        (
          await as("ada@example.com", "POST", `/api/v1/runs/${id}/messages`, {
            text: "Continue",
          })
        ).status,
      ).toBe(409);
      expect(paid).toBe(1);
      expect(calls.filter((c) => c === "POST /runs")).toHaveLength(2);
      const all = await as("ada@example.com", "GET", "/api/v1/runs");
      expect(await all.json()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires an expired busy reservation with missing run state without resetting its metadata", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { start, owners, phases, calls } = setup();
      const { id } = (await (await start("ada@example.com")).json()) as {
        id: string;
      };
      const original = await owners.get(id);
      assert(original);
      await owners.reserve(original, 1, 3, []);
      phases.delete(id);
      vi.setSystemTime(original.createdAt + 120 * 60_000);
      expect((await start("ada@example.com")).status).toBe(201);
      expect(await owners.get(id)).toMatchObject({
        createdAt: original.createdAt,
        busy: false,
        active: false,
      });
      expect(calls).not.toContain(`POST /runs/${id}/stop`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips retired reservations for admission but keeps every run in history", async () => {
    const { start, as, phases, calls } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await start("ada@example.com");
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      ids.push(id);
      if (i < 2) phases.set(id, "done");
    }
    const before = calls.length;
    expect(
      (
        await as("ada@example.com", "POST", `/api/v1/runs/${ids[2]}/messages`, {
          text: "Continue",
        })
      ).status,
    ).toBe(200);
    expect(
      calls.slice(before).filter((call) => call.startsWith("GET /runs/")),
    ).toEqual([`GET /runs/${ids[2]}`]);
    const history = await as("ada@example.com", "GET", "/api/v1/runs");
    const rows = (await history.json()) as { id: string }[];
    expect(rows.map((row) => row.id).sort()).toEqual(ids.sort());
  });

  it("disables bearer, visitor cookies and the operator proxy in Access mode", async () => {
    const { as, env, calls } = setup();
    const cookie = `${SESSION_COOKIE}=${crypto.randomUUID()}.${"0".repeat(64)}`;
    const headerCases: HeadersInit[] = [
      { authorization: "Bearer operator-secret" },
      { cookie },
    ];
    for (const headers of headerCases) {
      const response = await handleOrchestrator(
        new Request(`${SITE}/api/v1/runs/r1`, { headers }),
        env,
      );
      expect(response?.status).toBe(401);
      expect(await response?.json()).toMatchObject({ code: "access_required" });
    }
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
    const row = rows[0];
    assert(row);
    const id = row.id;
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

  it("treats everyone as an anonymous visitor when Access is not set up", async () => {
    const { as, calls } = setup({
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
    });
    const response = await as("ada@example.com", "GET", "/api/v1/runs/r1");
    // An Access identity is ignored without Access bindings: this is a new visitor with no runs.
    expect(response.status).toBe(404);
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
