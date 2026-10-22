import { EvidenceRecord } from "../../shared/evidence";
import type { D1RunStore } from "../store/d1";

// Evidence records and their files live in D1 and R2, next to the run they belong to.

// A signed-in Anchor session, bound to the origin the user signed in to.
export interface SignIn {
  sessionId: string;
  origin: string;
}

export interface EvidenceStore {
  putEvidence(
    record: EvidenceRecord,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void>;
  getEvidence(id: string): Promise<EvidenceRecord | null>;
  getContent(id: string): Promise<Uint8Array | null>;
  saveSignIn(runId: string, signIn: SignIn): Promise<void>;
  // Returns and forgets the run's sign-in session, so it is resumed once.
  takeSignIn(runId: string): Promise<SignIn | null>;
}

export const evidenceIdPattern = /^ev_[0-9a-f-]{36}$/;
export const runIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const valid = (id: string, pattern: RegExp, kind: string) => {
  if (!pattern.test(id)) throw new Error(`Invalid ${kind} id`);
};

export const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};
export const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

export function cloudflareEvidenceStore(db: D1RunStore): EvidenceStore {
  return {
    async putEvidence(record, content, signal) {
      valid(record.id, evidenceIdPattern, "evidence");
      if (!db.blobs)
        throw new Error("Evidence storage is not configured: missing BLOBS");
      const key = `evidence/${record.id}/${crypto.randomUUID()}`;
      signal?.throwIfAborted();
      try {
        await db.blobs.put(key, content);
        signal?.throwIfAborted();
        await db.rows(
          "INSERT INTO evidence(id,run_id,record,blob_key) VALUES (?,?,?,?)",
          record.id,
          record.runId,
          JSON.stringify(record),
          key,
        );
      } catch (error) {
        await db.blobs.delete(key);
        throw error;
      }
    },
    async getEvidence(id) {
      valid(id, evidenceIdPattern, "evidence");
      const [row] = await db.rows<{ record: string }>(
        "SELECT record FROM evidence WHERE id=?",
        id,
      );
      return row ? EvidenceRecord.parse(JSON.parse(row.record)) : null;
    },
    async getContent(id) {
      valid(id, evidenceIdPattern, "evidence");
      const [row] = await db.rows<{ blob_key: string }>(
        "SELECT blob_key FROM evidence WHERE id=?",
        id,
      );
      if (!row) return null;
      if (!db.blobs)
        throw new Error("Evidence storage is not configured: missing BLOBS");
      const object = await db.blobs.get(row.blob_key);
      if (!object) throw new Error("Evidence content is missing");
      return new Uint8Array(await object.arrayBuffer());
    },
    async saveSignIn(runId, signIn) {
      valid(runId, runIdPattern, "sign_in");
      await db.rows(
        "INSERT INTO sign_in(run_id,data) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data",
        runId,
        JSON.stringify(signIn),
      );
    },
    async takeSignIn(runId) {
      valid(runId, runIdPattern, "sign_in");
      const [row] = await db.rows<{ data: string }>(
        "DELETE FROM sign_in WHERE run_id=? RETURNING data",
        runId,
      );
      return row ? (JSON.parse(row.data) as SignIn) : null;
    },
  };
}
