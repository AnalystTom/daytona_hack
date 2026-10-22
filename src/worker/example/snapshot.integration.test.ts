import { assert, describe, expect, it } from "vitest";
import { D1RunStore } from "../store/d1";
import { testStorage } from "../test/storage";
import { handleExample } from "./routes";
import {
  cloudflareExampleStore,
  loadMedia,
  loadSnapshot,
  saveSnapshot,
  type Snapshot,
} from "./snapshot";

const env = testStorage();
const db = new D1RunStore(env.DB, env.BLOBS);
const store = cloudflareExampleStore(db);
const large = "a".repeat(130_000);

describe("example replacements in local D1 and R2", () => {
  it.each([
    [large, `${large}b`, 1],
    [large, "small", 0],
    ["small", large, 1],
    ["small", "other", 0],
  ] as const)(
    "reclaims superseded objects (%#)",
    async (before, after, count) => {
      await store.put("current", before);
      const previous = (await env.BLOBS.list()).objects.map(
        (object) => object.key,
      );
      await store.put("current", after);
      expect(await store.get("current")).toBe(after);
      expect((await env.BLOBS.list()).objects).toHaveLength(count);
      for (const key of previous) expect(await env.BLOBS.get(key)).toBeNull();
    },
  );

  it("keeps prior runs readable when the same run is saved again", async () => {
    const snapshot: Snapshot = {
      runId: "previous-run",
      target: "https://example.com",
      phase: "done",
      finishedAt: "2026-10-22T00:00:00Z",
      savedAt: "2026-10-22T00:00:00Z",
      events: [
        { seq: 1, ts: "2026-10-22T00:00:00Z", type: "chat", data: large },
      ],
      media: ["evidence"],
    };
    const bytes = new Uint8Array(130_000).fill(1);
    const files = new Map([["evidence", { contentType: "image/png", bytes }]]);
    await saveSnapshot(store, snapshot, files);
    snapshot.runId = "current-run";
    await saveSnapshot(store, snapshot, files);
    const count = (await env.BLOBS.list()).objects.length;
    const replacement = new Uint8Array(130_000).fill(2);
    await saveSnapshot(
      store,
      snapshot,
      new Map([["evidence", { contentType: "image/png", bytes: replacement }]]),
    );
    expect((await env.BLOBS.list()).objects).toHaveLength(count);
    expect(await loadSnapshot(store)).toEqual(snapshot);
    expect((await loadMedia(store, "previous-run", "evidence"))?.bytes).toEqual(
      bytes,
    );
    expect((await loadMedia(store, "current-run", "evidence"))?.bytes).toEqual(
      replacement,
    );
  });

  it.each([large, "inline"])(
    "preserves the old reference on rejected replacement (%#)",
    async (replacement) => {
      await store.put("current", large);
      const previous = (await env.BLOBS.list()).objects.map(
        (object) => object.key,
      );
      await db.rows(
        "CREATE TRIGGER reject_example BEFORE UPDATE ON example BEGIN SELECT RAISE(ABORT, 'rejected replacement'); END",
      );
      try {
        await expect(store.put("current", replacement)).rejects.toThrow(
          "rejected replacement",
        );
        expect(await store.get("current")).toBe(large);
        expect(
          (await env.BLOBS.list()).objects.map((object) => object.key),
        ).toEqual(previous);
      } finally {
        await db.rows("DROP TRIGGER reject_example");
      }
    },
  );

  it("reclaims each concurrent replacement without deleting the winner", async () => {
    await store.put("current", large);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const concurrentDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (++writes === 2) release();
            await ready;
            return target.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const concurrentStore = cloudflareExampleStore(
      new D1RunStore(concurrentDb, env.BLOBS),
    );
    const replacements = [`${large}b`, `${large}c`];
    await Promise.all(
      replacements.map((value) => concurrentStore.put("current", value)),
    );
    expect(replacements).toContain(await store.get("current"));
    const [reference] = await db.rows<{ blob_key: string }>(
      "SELECT blob_key FROM example WHERE key='current'",
    );
    expect(
      (await env.BLOBS.list()).objects.map((object) => object.key),
    ).toEqual([reference.blob_key]);
  });

  it.each([
    ["snapshot", "R2"],
    ["snapshot", "inline"],
    ["media", "R2"],
    ["media", "inline"],
  ] as const)(
    "serves a %s replaced with %s after its old reference was read",
    async (resource, storage) => {
      const snapshot: Snapshot = {
        runId: "current-run",
        target: "https://example.com",
        phase: "done",
        finishedAt: "2026-10-22T00:00:00Z",
        savedAt: "2026-10-22T00:00:00Z",
        events: [
          { seq: 1, ts: "2026-10-22T00:00:00Z", type: "chat", data: large },
        ],
        media: ["evidence"],
      };
      const original = new Uint8Array(130_000).fill(1);
      const files = new Map([
        ["evidence", { contentType: "image/png", bytes: original }],
      ]);
      await saveSnapshot(store, { ...snapshot, runId: "previous-run" }, files);
      await saveSnapshot(store, snapshot, files);

      let reached!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      let oldKey: string | undefined;
      const blobs = new Proxy(env.BLOBS, {
        get(target, property) {
          if (property === "get")
            return async (key: string) => {
              if (oldKey === undefined) {
                oldKey = key;
                reached();
                await resume;
              }
              return target.get(key);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const path =
        resource === "snapshot"
          ? "/api/v1/example"
          : "/api/v1/example/current-run/evidence/evidence";
      const reading = handleExample(
        new Request(`https://reversy.test${path}`),
        {
          ...env,
          BLOBS: blobs,
        },
      );
      const replacement: Snapshot = {
        ...snapshot,
        events: storage === "R2" ? snapshot.events : [],
        savedAt: "2026-10-22T01:00:00Z",
      };
      const bytes = new Uint8Array(storage === "R2" ? 130_000 : 3).fill(2);
      let response: Response | null;
      try {
        await paused;
        await saveSnapshot(
          store,
          replacement,
          new Map([["evidence", { contentType: "image/png", bytes }]]),
        );
        assert(oldKey);
        expect(await env.BLOBS.get(oldKey)).toBeNull();
      } finally {
        release();
        response = await reading;
      }
      assert(response);
      expect(response.status).toBe(200);
      if (resource === "snapshot") {
        expect(await response.json()).toEqual(replacement);
      } else {
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      }
      expect(
        (await loadMedia(store, "previous-run", "evidence"))?.bytes,
      ).toEqual(original);
    },
  );

  it("follows successive replacements before resolving the current object", async () => {
    await store.put("current", large);
    const replacements = [`${large}b`, `${large}c`];
    let reads = 0;
    const blobs = new Proxy(env.BLOBS, {
      get(target, property) {
        if (property === "get")
          return async (key: string) => {
            const replacement = replacements[reads++];
            if (replacement !== undefined)
              await store.put("current", replacement);
            return target.get(key);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const reader = cloudflareExampleStore(new D1RunStore(env.DB, blobs));
    expect(await reader.get("current")).toBe(replacements.at(-1));
    expect(reads).toBe(3);
    expect((await env.BLOBS.list()).objects).toHaveLength(1);
  });

  it("reports a missing object when its persisted reference is unchanged", async () => {
    await store.put("current", large);
    const [reference] = await db.rows<{ blob_key: string }>(
      "SELECT blob_key FROM example WHERE key='current'",
    );
    await env.BLOBS.delete(reference.blob_key);
    await expect(store.get("current")).rejects.toThrow(
      "Example content is missing",
    );
  });
});
