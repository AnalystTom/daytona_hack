// Role-scoped Agent Memory. Every role gets its own SurrealDB Agent Memory key, minted from the admin key
// with attenuated grants, so access is enforced by SurrealDB, not by this code:
//   site/<host>            durable site knowledge, shared across runs (new captures supersede old ones)
//   run/<run>/shared       first mate's plan and decisions, readable by its whole crew
//   run/<run>/task/<task>  a crewmate's private notes: other crewmates cannot read or write them
//   user/<user>            the captain's preferences
import type { Env } from "./types";

export type Role =
  | { role: "firstmate"; runId: string; host: string }
  | { role: "crew"; runId: string; taskId: string; host: string }
  | { role: "captain"; runId: string; userId: string };

const ROOT = "org/reversy";
const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60) || "x";

export function scopesFor(r: Role) {
  const run = `${ROOT}/run/${clean(r.runId)}`;
  if (r.role === "firstmate") {
    const site = `${ROOT}/site/${clean(r.host)}`;
    return { write: [run, `${run}/*`, site], read: [run, `${run}/*`, site], defaultWrite: `${run}/shared` };
  }
  if (r.role === "crew") {
    const site = `${ROOT}/site/${clean(r.host)}`;
    const task = `${run}/task/${clean(r.taskId)}`;
    return { write: [task, site], read: [task, `${run}/shared`, site], defaultWrite: task };
  }
  const user = `${ROOT}/user/${clean(r.userId)}`;
  return { write: [user], read: [user, `${run}/shared`], defaultWrite: user };
}

const keyCache = new Map<string, string>();

function base(env: Env) {
  return `${env.SPECTRON_URL!.replace(/\/$/, "")}/api/v1/${env.SPECTRON_CONTEXT_ID}`;
}

async function admin(env: Env, path: string, body: unknown) {
  return fetch(`${base(env)}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SPECTRON_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function ensureScopes(env: Env, paths: string[]) {
  const all = new Set<string>();
  for (const p of paths.map((x) => x.replace(/\/\*$/, ""))) {
    const parts = p.split("/");
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("/"));
  }
  for (const p of [...all].sort((a, b) => a.length - b.length)) await admin(env, "/scopes", { path: p });
}

/** The role's own attenuated key (minted once per isolate and cached). */
export async function keyFor(env: Env, r: Role): Promise<{ key: string; scopes: ReturnType<typeof scopesFor> }> {
  const scopes = scopesFor(r);
  const id = JSON.stringify(scopes);
  if (!keyCache.has(id)) {
    await ensureScopes(env, [...scopes.write, ...scopes.read]);
    const res = await admin(env, "/keys", {
      name: `${r.role}-${clean(r.runId)}-${"taskId" in r ? clean(r.taskId) : "userId" in r ? clean(r.userId) : "fm"}-${crypto.randomUUID().slice(0, 8)}`,
      grants: { "memory:read": scopes.read, "memory:write": scopes.write },
    });
    const body: any = await res.json();
    if (!res.ok || !body.key) throw new Error(`could not mint memory key: ${JSON.stringify(body).slice(0, 200)}`);
    keyCache.set(id, body.key);
  }
  return { key: keyCache.get(id)!, scopes };
}

async function asRole(env: Env, key: string, path: string, body: unknown) {
  const res = await fetch(`${base(env)}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/** Write a dated fact as the role. `scope` defaults to the role's own region; SurrealDB refuses anything outside it. */
export async function rememberAs(env: Env, r: Role, text: string, opts: { scope?: string; observedAt?: string } = {}) {
  const { key, scopes } = await keyFor(env, r);
  const scope = opts.scope || scopes.defaultWrite;
  return asRole(env, key, "/facts", {
    text, infer: "full", scopes: [[scope]], observed_at: opts.observedAt || new Date().toISOString(),
  });
}

/** Recall as the role: only what its key may read comes back, with sources and times. */
export async function recallAs(env: Env, r: Role, query: string, asOf?: string) {
  const { key, scopes } = await keyFor(env, r);
  const lens = scopes.read.filter((s) => !s.endsWith("/*")).map((s) => [s]);
  return asRole(env, key, "/query", { query, k: 10, lens, ...(asOf ? { asOf } : {}) });
}
