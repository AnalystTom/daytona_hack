import { beforeAll, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../../shared/contracts";
import type { Run } from "../../shared/runs";
import { MemoryRunStore } from "./memory";
import { surrealOwners } from "../orchestrator/owners";
import { type SurrealConfig, SurrealRunStore } from "./surreal";
import type { RunStore } from "./types";

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
    expect(await owners.reserve(second, 1, 2, [first.runId])).toBeUndefined();
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
        second.runId,
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
});
