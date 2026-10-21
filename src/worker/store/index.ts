import { SurrealRunStore } from "./surreal";

export interface StoreEnv {
  SURREALDB_URL?: string;
  SURREALDB_NAMESPACE?: string;
  SURREALDB_DATABASE?: string;
  SURREALDB_USER?: string;
  SURREALDB_PASSWORD?: string;
}

export const surrealBindings = [
  "SURREALDB_URL",
  "SURREALDB_NAMESPACE",
  "SURREALDB_DATABASE",
  "SURREALDB_USER",
  "SURREALDB_PASSWORD",
] as const;

export function resolveStore(
  env: StoreEnv,
): { store: SurrealRunStore } | { missing: string[] } {
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
