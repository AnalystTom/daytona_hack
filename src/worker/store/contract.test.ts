import { assert, beforeAll, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../../shared/contracts";
import type { Run } from "../../shared/runs";
import { MemoryRunStore } from "./memory";
import { surrealOwners } from "../orchestrator/owners";
import { type SurrealConfig, SurrealRunStore } from "./surreal";
import { type RunStore, StoreError } from "./types";
import {
  handleOrchestrator,
  type OrchestratorEnv,
} from "../orchestrator/front";
import { AUD, accessJwt, certs, TEAM } from "../orchestrator/access-fixtures";

// The same behaviour is required of every store. The SurrealDB suite runs only when
// SURREALDB_TEST_URL points at a server with root credentials (SURREALDB_TEST_USER/PASSWORD);
// it creates a throwaway namespace and database there.
const testEnv =
  (globalThis as { process?: { env: Record<string, string | undefined> } })
    .process?.env ?? {};

const surreal = testEnv.SURREALDB_TEST_URL
  ? {
      url: testEnv.SURREALDB_TEST_URL,
      namespace: `reversy_test_${Date.now()}`,
      database: "runs",
      user: testEnv.SURREALDB_TEST_USER ?? "root",
      password: testEnv.SURREALDB_TEST_PASSWORD ?? "root",
    }
  : undefined;

const stores: [string, () => RunStore][] = [
  ["memory", () => new MemoryRunStore()],
];
if (surreal) stores.push(["surreal", () => new SurrealRunStore(surreal)]);

beforeAll(async () => {
  if (!surreal) return;
  const response = await fetch(`${surreal.url}/rpc`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Basic ${btoa(`${surreal.user}:${surreal.password}`)}`,
    },
    body: JSON.stringify({
      id: 1,
      method: "query",
      params: [
        `DEFINE NAMESPACE ${surreal.namespace}; USE NS ${surreal.namespace}; DEFINE DATABASE ${surreal.database};`,
        {},
      ],
    }),
  });
  expect(response.ok).toBe(true);
});

// SurrealDB returns datetimes in its own format, so fixtures use the form it prints.
const now = "2026-10-16T12:00:00Z";
const newRun = (): Run => ({
  id: crypto.randomUUID(),
  url: "https://example.com/",
  goal: "Rebuild the landing page",
  status: "active",
  createdAt: now,
  updatedAt: now,
  specApprovedAt: null,
});
const event = (
  runId: string,
  eventId: string,
  extra: Partial<EventEnvelope> = {},
): EventEnvelope => ({
  schemaVersion: 1,
  eventId,
  sequence: 0,
  runId,
  timestamp: now,
  type: "status",
  state: "working",
  message: eventId,
  artifactRefs: [],
  ...extra,
});

describe.each(stores)("%s run store", (_name, makeStore) => {
  it("creates, reads and updates a run", async () => {
    const store = makeStore();
    const run = newRun();
    expect(await store.getRun(run.id)).toBeNull();
    await store.createRun(run);
    expect(await store.getRun(run.id)).toEqual(run);
    await Promise.all([
      store.updateRun(run.id, { status: "stopped" }),
      store.updateRun(run.id, { specApprovedAt: now }),
    ]);
    expect(await store.getRun(run.id)).toEqual({
      ...run,
      status: "stopped",
      specApprovedAt: now,
    });
  });

  it("assigns sequences in order and ignores duplicate event IDs", async () => {
    const store = makeStore();
    const run = newRun();
    await store.createRun(run);
    const first = await store.appendEvents(run.id, [
      event(run.id, "a", { sequence: 9 }),
      event(run.id, "b", { sequence: 3 }),
    ]);
    expect(first.stored.map((e) => [e.eventId, e.sequence])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(first.duplicates).toEqual([]);

    const second = await store.appendEvents(run.id, [
      event(run.id, "b", { message: "changed" }),
      event(run.id, "c"),
    ]);
    expect(second.stored.map((e) => [e.eventId, e.sequence])).toEqual([
      ["c", 3],
    ]);
    expect(second.duplicates).toEqual(["b"]);

    const all = await store.listEvents(run.id, 0, 100);
    expect(all.map((e) => [e.eventId, e.sequence, e.message])).toEqual([
      ["a", 1, "a"],
      ["b", 2, "b"],
      ["c", 3, "c"],
    ]);
    expect(all[0]).toEqual(event(run.id, "a", { sequence: 1 }));
    // Envelopes replay exactly as sent, including timestamp offsets.
    const offset = event(run.id, "d", {
      timestamp: "2026-10-16T14:00:00.000+02:00",
    });
    await store.appendEvents(run.id, [offset]);
    expect(await store.listEvents(run.id, 3, 1)).toEqual([
      { ...offset, sequence: 4 },
    ]);
    expect(
      (await store.listEvents(run.id, 1, 1)).map((e) => e.eventId),
    ).toEqual(["b"]);
  });

  it("reports an event ID repeated within one batch as a duplicate", async () => {
    const store = makeStore();
    const run = newRun();
    await store.createRun(run);
    const result = await store.appendEvents(run.id, [
      event(run.id, "a"),
      event(run.id, "b"),
      event(run.id, "a", { message: "again" }),
    ]);
    expect(result.stored.map((e) => [e.eventId, e.sequence])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(result.duplicates).toEqual(["a"]);
    const all = await store.listEvents(run.id, 0, 100);
    expect(all.map((e) => e.message)).toEqual(["a", "b"]);
  });

  it("keeps sequences unique under concurrent appends", async () => {
    const store = makeStore();
    const run = newRun();
    await store.createRun(run);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.appendEvents(run.id, [event(run.id, `e${i}`)]),
      ),
    );
    const sequences = (await store.listEvents(run.id, 0, 100)).map(
      (e) => e.sequence,
    );
    expect(sequences).toEqual(sequences.map((_, i) => i + 1));
  });

  it("records task state from events that carry a taskId", async () => {
    const store = makeStore();
    const run = newRun();
    await store.createRun(run);
    await store.appendEvents(run.id, [
      event(run.id, "t1-a", { taskId: "t1", state: "building" }),
      event(run.id, "t2-a", { taskId: "t2", state: "queued" }),
      event(run.id, "t1-b", { taskId: "t1", state: "in_review" }),
      event(run.id, "plain"),
    ]);
    expect(await store.listTasks(run.id)).toEqual([
      { taskId: "t1", state: "in_review", updatedAt: now, lastEventId: "t1-b" },
      { taskId: "t2", state: "queued", updatedAt: now, lastEventId: "t2-a" },
    ]);
  });

  it("writes and reads Agent Memory with sources", async () => {
    const store = makeStore();
    const run = newRun();
    await store.createRun(run);
    const observation = {
      id: crypto.randomUUID(),
      runId: run.id,
      kind: "observation" as const,
      content: "The hero uses a 64px heading.",
      sources: ["ev-screenshot-1"],
      createdAt: "2026-10-16T12:00:01Z",
    };
    const decision = {
      ...observation,
      id: crypto.randomUUID(),
      kind: "decision" as const,
      content: "Build the hero first.",
      sources: ["ev-screenshot-1", "event:abc"],
      createdAt: "2026-10-16T12:00:02Z",
    };
    await store.writeMemory(observation);
    await store.writeMemory(decision);
    expect(await store.readMemory(run.id)).toEqual([observation, decision]);
    expect(await store.readMemory(run.id, "decision")).toEqual([decision]);
  });

  it("records steering and approvals", async () => {
    const store = makeStore();
    const run = newRun();
    await store.createRun(run);
    await store.recordSteering({
      id: crypto.randomUUID(),
      runId: run.id,
      kind: "message",
      text: "Skip the pricing page",
      eventId: "e1",
      createdAt: now,
    });
    await store.recordApproval({
      id: crypto.randomUUID(),
      runId: run.id,
      kind: "spec",
      eventId: "e2",
      createdAt: now,
    });
  });
});

describe.skipIf(!surreal)("surreal run owners", () => {
  it("preserves UUID-prefixed full emails and isolates ownership, admission and daily quotas by domain", async () => {
    const owners = surrealOwners(new SurrealRunStore(surreal as SurrealConfig));
    const local = crypto.randomUUID();
    const a = {
      runId: crypto.randomUUID(),
      owner: `${local}@example.com`,
      createdAt: Date.now(),
    };
    const b = {
      ...a,
      runId: crypto.randomUUID(),
      owner: `${local}@example.org`,
    };
    expect(await owners.reserve(a, 1, 1, [])).toBeUndefined();
    expect(await owners.reserve(b, 1, 1, [])).toBeUndefined();
    expect(await owners.get(a.runId)).toMatchObject(a);
    expect(await owners.get(b.runId)).toMatchObject(b);
    expect((await owners.list(a.owner, 0)).map((r) => r.runId)).toEqual([
      a.runId,
    ]);
    expect((await owners.list(b.owner, 0)).map((r) => r.runId)).toEqual([
      b.runId,
    ]);
    expect(await owners.list(local, 0)).toEqual([]);
    await expect(
      owners.reserve({ ...a, owner: b.owner }, 2, 1, []),
    ).rejects.toThrow("Run owner mismatch");
    expect(await owners.reserve(a, 1, 1, [])).toBeUndefined();
    await owners.finish(a.runId, b.owner);
    expect(await owners.get(a.runId)).toMatchObject({
      owner: a.owner,
      busy: true,
    });
    await owners.finish(a.runId, a.owner);
    expect(await owners.get(a.runId)).toMatchObject({
      owner: a.owner,
      busy: false,
    });
    const currentA = await owners.get(a.runId);
    assert(currentA);
    expect(
      await owners.reserve({ ...b, runId: crypto.randomUUID() }, 1, 1, [
        currentA,
      ]),
    ).toBe("active_run_limit");
    expect(await owners.get(a.runId)).toMatchObject({ active: true });
    expect(
      await owners.reserve({ ...a, runId: crypto.randomUUID() }, 1, 1, [
        currentA,
      ]),
    ).toBe("daily_run_limit");
    expect(await owners.get(b.runId)).toMatchObject({
      owner: b.owner,
      active: true,
    });
    expect(
      await owners.reserve({ ...b, runId: crypto.randomUUID() }, 1, 1, [b]),
    ).toBe("daily_run_limit");
    const env: OrchestratorEnv = {
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      ORCHESTRATOR: {
        fetch: async () => Response.json({ id: a.runId }),
      } as unknown as Fetcher,
    };
    for (const [owner, status] of [
      [a.owner, 200],
      [b.owner, 404],
    ] as const) {
      const response = await handleOrchestrator(
        new Request(`https://reversy.test/api/v1/runs/${a.runId}`, {
          headers: {
            "cf-access-jwt-assertion": await accessJwt({ email: owner }),
          },
        }),
        env,
        { owners, fetcher: certs },
      );
      expect(response?.status).toBe(status);
    }
  });

  it("atomically admits starts and persists ownership and daily charges", async () => {
    const owners = surrealOwners(new SurrealRunStore(surreal as SurrealConfig));
    const owner = `${crypto.randomUUID()}@example.com`;
    const a = { runId: crypto.randomUUID(), owner, createdAt: Date.now() };
    const b = { ...a, runId: crypto.randomUUID() };
    const results = await Promise.all([
      owners.reserve(a, 1, 2, []),
      owners.reserve(b, 1, 2, []),
    ]);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    expect(results.filter((r) => r === "active_run_limit")).toHaveLength(1);
    const first = results[0] === undefined ? a : b;
    expect(await owners.get(first.runId)).toMatchObject(first);
    expect(await owners.list(owner, 0)).toHaveLength(1);
    const second = { ...a, runId: crypto.randomUUID() };
    expect(await owners.reserve(second, 1, 2, [first])).toBeUndefined();
    expect(
      await owners.reserve(
        {
          ...a,
          runId: crypto.randomUUID(),
          createdAt: a.createdAt + 86_400_000,
        },
        1,
        2,
        [],
      ),
    ).toBe("active_run_limit");
    expect(
      await owners.reserve({ ...a, runId: crypto.randomUUID() }, 1, 2, [
        second,
      ]),
    ).toBe("daily_run_limit");
    expect(await owners.list(owner, 0)).toHaveLength(2);
    expect(
      await owners.reserve(
        {
          ...a,
          runId: crypto.randomUUID(),
          createdAt: a.createdAt + 86_400_000,
        },
        1,
        2,
        [],
      ),
    ).toBeUndefined();
    expect(
      await owners.reserve(
        { ...a, runId: crypto.randomUUID(), owner: "other@example.com" },
        1,
        2,
        [],
      ),
    ).toBeUndefined();
  });
  it("re-admits existing runs without daily charges and ignores stale retirement snapshots", async () => {
    const owners = surrealOwners(new SurrealRunStore(surreal as SurrealConfig));
    const a = {
      runId: crypto.randomUUID(),
      owner: `${crypto.randomUUID()}@example.com`,
      createdAt: Date.now(),
    };
    expect(await owners.reserve(a, 1, 1, [])).toBeUndefined();
    const old = await owners.get(a.runId);
    assert(old);
    expect(
      await owners.reserve({ ...a, runId: crypto.randomUUID() }, 1, 1, [old]),
    ).toBe("daily_run_limit");
    expect(await owners.reserve(a, 1, 1, [])).toBeUndefined();
    expect(await owners.get(a.runId)).toMatchObject({ ...a, busy: true });
    const next = {
      ...a,
      runId: crypto.randomUUID(),
      createdAt: a.createdAt + 86_400_000,
    };
    expect(await owners.reserve(next, 1, 1, [old])).toBe("active_run_limit");
    await owners.finish(a.runId, a.owner);
    expect(await owners.reserve(next, 1, 1, [old])).toBe("active_run_limit");
    const current = await owners.get(a.runId);
    assert(current);
    expect(await owners.reserve(next, 1, 1, [current])).toBeUndefined();
    expect(await owners.reserve(a, 1, 1, [])).toBe("active_run_limit");
    expect(await owners.get(a.runId)).toMatchObject({ ...a, busy: false });
  });
  it("recovers expired busy admission through confirmed stop and the real store without resetting its charge", async () => {
    let storageUnavailable = false;
    const store = new SurrealRunStore(
      surreal as SurrealConfig,
      async (input, init) => {
        if (storageUnavailable) throw new Error("test database unavailable");
        return fetch(input, init);
      },
    );
    const owners = surrealOwners(store);
    const original = {
      runId: crypto.randomUUID(),
      owner: `${crypto.randomUUID()}@example.com`,
      createdAt: Date.now() - 60_000,
    };
    expect(await owners.reserve(original, 1, 2, [])).toBeUndefined();
    expect(await owners.reserve(original, 1, 2, [])).toBeUndefined();
    const abandoned = await owners.get(original.runId);
    assert(abandoned);
    storageUnavailable = true;
    await expect(
      owners.finish(original.runId, original.owner),
    ).rejects.toBeInstanceOf(StoreError);
    storageUnavailable = false;
    expect(await owners.get(original.runId)).toMatchObject({
      busy: true,
      active: true,
    });
    let cancellationFails = true;
    let pendingStop = false;
    let paidStarts = 0;
    const env: OrchestratorEnv = {
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      RUN_MAX_MINUTES: "1",
      RUNS_PER_DAY: "2",
      ORCHESTRATOR: {
        async fetch(input: string, init: RequestInit = {}) {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (request.method === "POST" && path === "/runs") {
            const { id } = (await request.json()) as { id: string };
            paidStarts++;
            return Response.json({ id, phase: "brief" }, { status: 201 });
          }
          if (request.method === "POST" && path.endsWith("/stop")) {
            pendingStop = true;
            if (cancellationFails)
              return Response.json(
                { error: "cancellation unavailable" },
                { status: 503 },
              );
            pendingStop = false;
            return Response.json({ phase: "stopped" });
          }
          return Response.json({
            phase: "brief",
            pending: pendingStop ? "stop" : undefined,
          });
        },
      } as unknown as Fetcher,
    };
    const headers = {
      origin: "https://reversy.test",
      "cf-access-jwt-assertion": await accessJwt({ email: original.owner }),
    };
    const start = () =>
      handleOrchestrator(
        new Request("https://reversy.test/api/v1/runs", {
          method: "POST",
          headers,
          body: JSON.stringify({ url: "https://example.com", goal: "Rebuild" }),
        }),
        env,
        { owners, fetcher: certs },
      );
    expect((await start())?.status).toBe(502);
    expect(await owners.get(original.runId)).toMatchObject({
      busy: true,
      active: true,
    });
    expect(paidStarts).toBe(0);
    cancellationFails = false;
    expect((await start())?.status).toBe(201);
    expect(paidStarts).toBe(1);
    expect(await owners.get(original.runId)).toMatchObject({
      ...original,
      revision: abandoned.revision,
      busy: false,
      active: false,
    });
    const history = await handleOrchestrator(
      new Request("https://reversy.test/api/v1/runs", { headers }),
      env,
      { owners, fetcher: certs },
    );
    assert(history);
    const rows = (await history.json()) as { id: string; createdAt: string }[];
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({
      id: original.runId,
      createdAt: new Date(original.createdAt).toISOString(),
    });
    const day = new Date(original.createdAt).toISOString().slice(0, 10);
    const newRun = rows.find((row) => row.id !== original.runId);
    assert(newRun);
    const newDay = newRun.createdAt.slice(0, 10);
    const [charged] = await store.query(
      "SELECT VALUE runs FROM ONLY type::record('run_quota', [array::join($owner, ''), $day])",
      { owner: Array.from(original.owner), day },
    );
    expect(Number(charged)).toBe(day === newDay ? 2 : 1);
  });
});
