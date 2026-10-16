import { MemoryRunStore } from "./memory";
import { SurrealRunStore } from "./surreal";
import type { RunStore } from "./types";

export interface StoreEnv {
  SURREALDB_URL?: string;
  SURREALDB_NAMESPACE?: string;
  SURREALDB_DATABASE?: string;
  SURREALDB_USER?: string;
  SURREALDB_PASSWORD?: string;
  // "memory" enables the in-process store, honoured only for requests to localhost.
  RUN_STORE?: string;
}

export const surrealBindings = [
  "SURREALDB_URL",
  "SURREALDB_NAMESPACE",
  "SURREALDB_DATABASE",
  "SURREALDB_USER",
  "SURREALDB_PASSWORD",
] as const;

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
let memoryStore: MemoryRunStore | undefined;

export function resolveStore(
  env: StoreEnv,
  requestUrl: URL,
): { store: RunStore } | { missing: string[] } {
  if (env.RUN_STORE === "memory" && localHosts.has(requestUrl.hostname)) {
    memoryStore ??= new MemoryRunStore();
    return { store: memoryStore };
  }
  const missing = surrealBindings.filter((name) => !env[name]);
  if (missing.length > 0) return { missing };
  return {
    store: new SurrealRunStore({
      url: env.SURREALDB_URL as string,
      namespace: env.SURREALDB_NAMESPACE as string,
      database: env.SURREALDB_DATABASE as string,
      user: env.SURREALDB_USER as string,
      password: env.SURREALDB_PASSWORD as string,
    }),
  };
}
