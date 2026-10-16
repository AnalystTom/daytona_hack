import { EvidenceRecord } from "../../shared/evidence";

// Evidence records and their files live in SurrealDB, reached over its HTTP RPC endpoint.
// shortcut: own minimal client until the run API's store lands on main; switch to it then.

export const surrealBindings = [
  "SURREALDB_URL",
  "SURREALDB_NAMESPACE",
  "SURREALDB_DATABASE",
  "SURREALDB_USER",
  "SURREALDB_PASSWORD",
] as const;
type SurrealEnv = Record<(typeof surrealBindings)[number], string>;

// A signed-in Anchor session, bound to the origin the user signed in to.
export interface SignIn {
  sessionId: string;
  origin: string;
}

export interface EvidenceStore {
  putEvidence(record: EvidenceRecord, content: Uint8Array): Promise<void>;
  getEvidence(id: string): Promise<EvidenceRecord | null>;
  getContent(id: string): Promise<Uint8Array | null>;
  saveSignIn(runId: string, signIn: SignIn): Promise<void>;
  // Returns and forgets the run's sign-in session, so it is resumed once.
  takeSignIn(runId: string): Promise<SignIn | null>;
}

// RPC bodies are capped at 4 MiB by default; 2 MiB of bytes is under 3 MiB as base64.
const chunkBytes = 2 * 1024 * 1024;

// Record IDs are embedded in SurrealQL, so only these shapes are accepted.
export const evidenceIdPattern = /^ev_[0-9a-f-]{36}$/;
export const runIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const key = (table: string, id: string, pattern: RegExp) => {
  if (!pattern.test(id)) throw new Error(`Invalid ${table} id`);
  return `${table}:\`${id}\``;
};
const chunkKey = (id: string, index: number) =>
  key("evidence_chunk", `${id}_${index}`, /^ev_[0-9a-f-]{36}_\d+$/);

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};
export const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

export function surrealStore(env: SurrealEnv): EvidenceStore {
  const endpoint = `${env.SURREALDB_URL.replace(/\/+$/, "")}/rpc`;
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Surreal-NS": env.SURREALDB_NAMESPACE,
    "Surreal-DB": env.SURREALDB_DATABASE,
    Authorization: `Basic ${btoa(`${env.SURREALDB_USER}:${env.SURREALDB_PASSWORD}`)}`,
  };

  // Runs one statement and returns its result rows.
  async function query<T>(
    sql: string,
    vars: Record<string, unknown> = {},
  ): Promise<T[]> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: 1, method: "query", params: [sql, vars] }),
    });
    if (!response.ok) {
      throw new Error(`SurrealDB request failed with ${response.status}`);
    }
    const body = (await response.json()) as {
      result?: { status: string; result: unknown }[];
      error?: { message: string };
    };
    const statement = body.result?.[0];
    if (body.error || statement?.status !== "OK") {
      throw new Error(
        `SurrealDB query failed: ${body.error?.message ?? String(statement?.result)}`,
      );
    }
    return statement.result as T[];
  }

  return {
    async putEvidence(record, content) {
      const chunks = Math.ceil(content.length / chunkBytes);
      for (let index = 0; index < chunks; index++) {
        const data = content.subarray(
          index * chunkBytes,
          (index + 1) * chunkBytes,
        );
        await query(`CREATE ${chunkKey(record.id, index)} CONTENT $chunk`, {
          chunk: { evidence: record.id, index, data: toBase64(data) },
        });
      }
      // The record is written last, so a readable record always has all its chunks.
      await query(
        `CREATE ${key("evidence", record.id, evidenceIdPattern)} CONTENT $row`,
        { row: { runId: record.runId, chunks, record } },
      );
    },

    async getEvidence(id) {
      const [record] = await query<unknown>(
        `SELECT VALUE record FROM ${key("evidence", id, evidenceIdPattern)}`,
      );
      return record === undefined ? null : EvidenceRecord.parse(record);
    },

    async getContent(id) {
      const [chunks] = await query<number>(
        `SELECT VALUE chunks FROM ${key("evidence", id, evidenceIdPattern)}`,
      );
      if (chunks === undefined) return null;
      if (chunks === 0) return new Uint8Array();
      const keys = Array.from({ length: chunks }, (_, i) => chunkKey(id, i));
      const parts = await query<string>(
        `SELECT VALUE data FROM [${keys.join(", ")}]`,
      );
      const bytes = parts.map(fromBase64);
      const out = new Uint8Array(
        bytes.reduce((sum, part) => sum + part.length, 0),
      );
      let offset = 0;
      for (const part of bytes) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    },

    async saveSignIn(runId, signIn) {
      await query(
        `UPSERT ${key("sign_in", runId, runIdPattern)} CONTENT $row`,
        {
          row: { ...signIn, createdAt: new Date().toISOString() },
        },
      );
    },

    async takeSignIn(runId) {
      const [before] = await query<SignIn>(
        `DELETE ${key("sign_in", runId, runIdPattern)} RETURN BEFORE`,
      );
      return before
        ? { sessionId: before.sessionId, origin: before.origin }
        : null;
    },
  };
}
