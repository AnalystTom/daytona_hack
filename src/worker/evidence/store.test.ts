import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvidenceRecord } from "../../shared/evidence";
import { SurrealRunStore } from "../store/surreal";
import { surrealOk } from "./fixtures";
import { surrealStore } from "./store";

const config = {
  url: "https://db.example.test/",
  namespace: "reversy",
  database: "main",
  user: "user",
  password: "pass",
};
const db = (database = config.database) =>
  new SurrealRunStore({ ...config, database });

const record: EvidenceRecord = {
  id: "ev_00000000-0000-4000-8000-000000000000",
  runId: "run_1",
  kind: "dom",
  label: "observed",
  pageOrState: "/",
  url: "https://example.com/",
  tool: "anchor",
  capturedAt: "2026-10-16T10:00:00.000Z",
  contentHash: "sha256:00",
  limitations: [],
  contentType: "text/html",
  byteLength: 3,
};

// Fixture SurrealDB RPC endpoint: records each statement after the run store's
// schema and answers from a queue.
function fakeSurreal(responses: unknown[]) {
  const requests: {
    sql: string;
    vars: Record<string, unknown>;
    headers: Headers;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://db.example.test/rpc");
      const { params } = JSON.parse(String(init.body));
      if (params[0].includes("DEFINE TABLE"))
        return Response.json(surrealOk([]));
      requests.push({
        sql: params[0],
        vars: params[1],
        headers: new Headers(init.headers),
      });
      return Response.json(responses.shift() ?? surrealOk([]));
    }),
  );
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe("surrealStore (fixture SurrealDB responses)", () => {
  it("writes content chunks before the record, with namespace and auth headers", async () => {
    const requests = fakeSurreal([]);
    await surrealStore(db()).putEvidence(record, new Uint8Array([60, 104, 62]));

    expect(requests.map((r) => r.sql)).toEqual([
      `CREATE evidence_chunk:\`${record.id}_0\` CONTENT $chunk`,
      `CREATE evidence:\`${record.id}\` CONTENT $row`,
    ]);
    expect(requests[0]?.vars.chunk).toEqual({
      evidence: record.id,
      index: 0,
      data: "PGg+",
    });
    expect(requests[1]?.vars.row).toEqual({
      runId: "run_1",
      chunks: 1,
      record,
    });
    expect(requests[0]?.headers.get("surreal-ns")).toBe("reversy");
    expect(requests[0]?.headers.get("surreal-db")).toBe("main");
    expect(requests[0]?.headers.get("authorization")).toBe(
      `Basic ${btoa("user:pass")}`,
    );
  });

  it("reassembles content from its chunks in order", async () => {
    const requests = fakeSurreal([
      surrealOk([2]),
      surrealOk(["PGg+", "PC9oPg=="]),
    ]);
    const bytes = await surrealStore(db()).getContent(record.id);

    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe("<h></h>");
    expect(requests[1]?.sql).toBe(
      `SELECT VALUE data FROM [evidence_chunk:\`${record.id}_0\`, evidence_chunk:\`${record.id}_1\`]`,
    );
  });

  it("reads a record back and returns null when absent", async () => {
    fakeSurreal([surrealOk([record]), surrealOk([])]);
    const store = surrealStore(db());
    expect(await store.getEvidence(record.id)).toEqual(record);
    expect(await store.getEvidence(record.id)).toBeNull();
  });

  it("takes a sign-in session once", async () => {
    const requests = fakeSurreal([
      surrealOk([{ sessionId: "s1", origin: "https://example.com" }]),
      surrealOk([]),
    ]);
    const store = surrealStore(db());
    expect(await store.takeSignIn("run_1")).toEqual({
      sessionId: "s1",
      origin: "https://example.com",
    });
    expect(await store.takeSignIn("run_1")).toBeNull();
    expect(requests[0]?.sql).toBe("DELETE sign_in:`run_1` RETURN BEFORE");
  });

  it("works on a fresh database whose tables do not exist yet", async () => {
    // Like SurrealDB 3.x: reading or deleting from an undefined table fails.
    const defined = new Set<string>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const sql: string = JSON.parse(String(init.body)).params[0];
        const statements = sql
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean);
        return Response.json({
          id: 1,
          result: statements.map((statement) => {
            const table = /^DEFINE TABLE IF NOT EXISTS (\w+)/.exec(statement);
            if (table) {
              defined.add(table[1] as string);
              return { status: "OK", result: null };
            }
            const target = /(?:FROM|DELETE) (\w+):/.exec(statement)?.[1];
            return target && !defined.has(target)
              ? {
                  status: "ERR",
                  result: `The table '${target}' does not exist`,
                }
              : { status: "OK", result: [] };
          }),
        });
      }),
    );
    const store = surrealStore(db("fresh"));
    expect(await store.takeSignIn("run_1")).toBeNull();
    expect(await store.getEvidence(record.id)).toBeNull();
    expect(await store.getContent(record.id)).toBeNull();
  });

  it("raises statement errors and refuses ids that could inject SurrealQL", async () => {
    fakeSurreal([{ id: 1, result: [{ status: "ERR", result: "boom" }] }]);
    const store = surrealStore(db());
    await expect(store.getEvidence(record.id)).rejects.toThrow("boom");
    await expect(
      store.getEvidence("ev_x`; REMOVE TABLE evidence; --"),
    ).rejects.toThrow("Invalid evidence id");
  });
});
