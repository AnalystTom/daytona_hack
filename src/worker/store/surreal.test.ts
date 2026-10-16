import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../../shared/contracts";
import { SurrealRunStore } from "./surreal";
import { StoreError } from "./types";

const config = {
  url: "https://db.example.com/",
  namespace: "reversy",
  database: "runs",
  user: "worker",
  password: "secret",
};

const storeAnswering = (answer: () => Response | Promise<Response>) => {
  const requests: Request[] = [];
  const store = new SurrealRunStore(config, async (input, init) => {
    requests.push(new Request(input, init));
    return answer();
  });
  return { store, requests };
};

describe("SurrealRunStore over HTTP", () => {
  it("sends authenticated RPC queries to the configured namespace and database", async () => {
    const { store, requests } = storeAnswering(() =>
      Response.json({ id: 1, result: [{ status: "OK", result: null }] }),
    );
    expect(await store.getRun("r1")).toBeNull();
    const request = requests.at(-1) as Request;
    expect(request.url).toBe("https://db.example.com/rpc");
    expect(request.headers.get("surreal-ns")).toBe("reversy");
    expect(request.headers.get("surreal-db")).toBe("runs");
    expect(request.headers.get("authorization")).toBe(
      `Basic ${btoa("worker:secret")}`,
    );
    const body = (await request.json()) as {
      method: string;
      params: unknown[];
    };
    expect(body.method).toBe("query");
    expect(body.params[1]).toEqual({ runId: "r1" });
  });

  it.each([
    ["an HTTP error", () => new Response("nope", { status: 502 })],
    [
      "an RPC error",
      () => Response.json({ id: 1, error: { message: "bad auth" } }),
    ],
    [
      "a failed statement",
      () => Response.json({ id: 1, result: [{ status: "ERR", result: "x" }] }),
    ],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
  ])("reports %s as a StoreError", async (_name, answer) => {
    const { store } = storeAnswering(answer);
    await expect(store.getRun("r1")).rejects.toBeInstanceOf(StoreError);
  });

  it("preserves the cause of an aborted transaction for conflict handling", async () => {
    const { store } = storeAnswering(() =>
      Response.json({
        result: [
          {
            status: "ERR",
            result: "The query was not executed due to a failed transaction",
          },
          { status: "ERR", result: "Transaction conflict" },
        ],
      }),
    );
    await expect(
      store.query("BEGIN TRANSACTION; COMMIT TRANSACTION;"),
    ).rejects.toThrow("Transaction conflict");
  });

  describe("appendEvents", () => {
    const event = (eventId: string): EventEnvelope => ({
      schemaVersion: 1,
      eventId,
      sequence: 0,
      runId: "r1",
      timestamp: "2026-10-16T12:00:00Z",
      type: "status",
      state: "working",
      message: eventId,
      artifactRefs: [],
    });
    const ok = (...results: unknown[]) =>
      Response.json({
        id: 1,
        result: results.map((result) => ({ status: "OK", result })),
      });
    // Answers the schema query, then the append transaction (via `append`), then the SELECT.
    const fakeSurreal = (append: () => Response | Promise<Response>) => {
      const sent: { sql: string; vars: Record<string, unknown> }[] = [];
      const store = new SurrealRunStore(
        { ...config, url: `https://${crypto.randomUUID()}.example.com` },
        async (_input, init) => {
          const { params } = JSON.parse(String(init?.body)) as {
            params: [string, Record<string, unknown>];
          };
          const [sql, vars] = params;
          sent.push({ sql, vars });
          if (sql.includes("BEGIN TRANSACTION")) return append();
          if (sql.startsWith("SELECT envelope")) {
            const ids = vars.ids as string[];
            return ok(
              ids.map((id, i) => ({
                envelope: JSON.stringify(event(id)),
                sequence: i + 7,
              })),
            );
          }
          return ok(null);
        },
      );
      return { store, sent };
    };

    it("reports an event ID repeated within one batch as a duplicate", async () => {
      const { store, sent } = fakeSurreal(() =>
        ok(null, null, null, null, [], null),
      );
      const result = await store.appendEvents("r1", [
        event("a"),
        event("b"),
        event("a"),
      ]);
      const append = sent.find((q) => q.sql.includes("BEGIN TRANSACTION"));
      expect(
        (
          (append as (typeof sent)[number]).vars.events as { eventId: string }[]
        ).map((e) => e.eventId),
      ).toEqual(["a", "b"]);
      expect(result.stored.map((e) => [e.eventId, e.sequence])).toEqual([
        ["a", 7],
        ["b", 8],
      ]);
      expect(result.duplicates).toEqual(["a"]);
    });

    it("returns the stored events when a retry finds an earlier attempt committed them", async () => {
      let attempts = 0;
      const { store } = fakeSurreal(() =>
        ++attempts === 1
          ? Promise.reject(new TypeError("connection reset"))
          : ok(null, null, null, null, ["a"], null),
      );
      const result = await store.appendEvents("r1", [event("a")]);
      expect(attempts).toBe(2);
      expect(result.stored.map((e) => [e.eventId, e.sequence])).toEqual([
        ["a", 7],
      ]);
      expect(result.duplicates).toEqual([]);
    });

    it("still reports a duplicate found on the first attempt", async () => {
      const { store } = fakeSurreal(() =>
        ok(null, null, null, null, ["a"], null),
      );
      const result = await store.appendEvents("r1", [event("a"), event("b")]);
      expect(result.stored.map((e) => e.eventId)).toEqual(["b"]);
      expect(result.duplicates).toEqual(["a"]);
    });
  });
});
