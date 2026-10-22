import { D1RunStore } from "./d1";

export interface StoreEnv {
  DB?: D1Database;
  BLOBS?: R2Bucket;
}

export const storageBindings = ["DB", "BLOBS"] as const;

export function resolveStore(
  env: StoreEnv,
): { store: D1RunStore } | { missing: string[] } {
  if (!env.DB) return { missing: ["DB"] };
  return { store: new D1RunStore(env.DB, env.BLOBS) };
}
