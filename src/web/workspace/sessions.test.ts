import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionTitle } from "./SessionSwitcher";
import {
  listSessions,
  ownedSessions,
  forgetSession,
  loadLayout,
  rememberSession,
  saveLayout,
} from "./sessions";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
});

describe("sessions", () => {
  it("filters a shared browser's cached targets, IDs and phases against the caller's history", async () => {
    rememberSession({
      runId: "alice-run",
      target: "https://alice.example/private",
      phase: "building",
    });
    const cached = listSessions();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json([{ id: "bob-run", createdAt: "2026-10-16T12:00:00Z" }]),
    );
    expect(await ownedSessions(fetchImpl)).toEqual({ ok: true, value: [] });
    expect(listSessions()).toEqual(cached);
    rememberSession({
      runId: "bob-run",
      target: "https://bob.example/",
      phase: "brief",
    });
    const result = await ownedSessions(fetchImpl);
    expect(result.ok && result.value.map((s) => s.runId)).toEqual(["bob-run"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/runs",
      expect.objectContaining({
        method: "GET",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      }),
    );
  });

  it("keeps the same user's cache through Access expiry but exposes no cached data before reauthentication", async () => {
    rememberSession({
      runId: "alice-run",
      target: "https://alice.example/",
      phase: "done",
    });
    const cached = listSessions();
    expect(
      await ownedSessions(async () => new Response(null, { status: 401 })),
    ).toMatchObject({ ok: false, error: "access_required" });
    expect(listSessions()).toEqual(cached);
    expect(
      await ownedSessions(async () =>
        Response.json([{ id: "alice-run", createdAt: "2026-10-16T12:00:00Z" }]),
      ),
    ).toEqual({ ok: true, value: cached });
  });

  it("confirms cached runs individually for the operator API without history support", async () => {
    rememberSession({ runId: "allowed", target: "https://allowed.example" });
    rememberSession({ runId: "missing", target: "https://missing.example" });
    const cached = listSessions();
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      input === "/api/v1/runs/allowed"
        ? Response.json({ id: "allowed" })
        : new Response(null, { status: 404 }),
    );
    const result = await ownedSessions(fetchImpl);
    expect(result.ok && result.value.map((s) => s.runId)).toEqual(["allowed"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(listSessions()).toEqual(cached);
  });

  it.each(["access", "operator"] as const)(
    "preserves another tab's additions and updates during %s validation",
    async (mode) => {
      rememberSession(
        { runId: "existing", target: "https://old.example", phase: "brief" },
        1,
      );
      let entered!: () => void;
      let release!: (response: Response) => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const waiting = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        if (mode === "operator" && input === "/api/v1/runs")
          return new Response(null, { status: 404 });
        entered();
        return waiting;
      });
      const validating = ownedSessions(fetchImpl);
      await started;
      rememberSession(
        { runId: "new-run", target: "https://new.example", phase: "brief" },
        2,
      );
      rememberSession(
        {
          runId: "existing",
          target: "https://updated.example",
          phase: "building",
        },
        3,
      );
      const concurrent = listSessions();
      release(
        Response.json(
          mode === "access"
            ? [{ id: "existing", createdAt: "2026-10-16T12:00:00Z" }]
            : { id: "existing" },
        ),
      );
      const result = await validating;
      expect(result.ok && result.value.map((session) => session.runId)).toEqual(
        ["existing"],
      );
      expect(listSessions()).toEqual(concurrent);
    },
  );

  it("removes a refused run and its layout while retaining other sessions", () => {
    rememberSession({ runId: "refused", target: "https://private.example" });
    rememberSession({ runId: "allowed" });
    saveLayout("refused", { spec: { x: 20, y: 40 } });
    forgetSession("refused");
    expect(listSessions().map((s) => s.runId)).toEqual(["allowed"]);
    expect(loadLayout("refused")).toEqual({});
  });

  it("lists runs newest first and fills in what becomes known", () => {
    rememberSession({ runId: "run-a", target: "https://a.example/" }, 1);
    rememberSession({ runId: "run-b" }, 2);
    rememberSession({ runId: "run-a", phase: "planning" }, 3);
    expect(listSessions()).toEqual([
      {
        runId: "run-a",
        target: "https://a.example/",
        phase: "planning",
        updatedAt: 3,
      },
      { runId: "run-b", updatedAt: 2 },
    ]);
  });

  it("ignores unreadable storage", () => {
    localStorage.setItem("reversy.sessions", "{not json");
    expect(listSessions()).toEqual([]);
    localStorage.setItem(
      "reversy.sessions",
      JSON.stringify([{ runId: "../x", updatedAt: 1 }]),
    );
    expect(listSessions()).toEqual([]);
  });

  it("keeps card positions per run", () => {
    saveLayout("run-a", { "draft-spec": { x: 40, y: -20 } });
    expect(loadLayout("run-a")).toEqual({ "draft-spec": { x: 40, y: -20 } });
    expect(loadLayout("run-b")).toEqual({});
  });

  it("names a session by its target, or its run until one is known", () => {
    expect(
      sessionTitle({ runId: "r", target: "https://www.gs.com/insights/x" }),
    ).toBe("www.gs.com/insights/x");
    expect(sessionTitle({ runId: "r", target: "https://a.example/" })).toBe(
      "a.example",
    );
    expect(sessionTitle({ runId: "0123456789abcdef" })).toBe("Run 01234567");
  });
});
