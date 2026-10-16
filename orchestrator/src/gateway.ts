// Network gateway for the run sandbox. On Daytona Tier 1/2 the sandbox cannot reach Anchor or SurrealDB,
// so Firstmate's crew calls these routes (via the `reversy` CLI) instead. Keys stay on Cloudflare either way:
// the sandbox only holds GATEWAY_TOKEN. Also relays captain (user) messages into the first mate's tmux pane.
import { Daytona } from "./daytona";
import { recallAs, rememberAs, type Role } from "./memory";
import { anchorScreenshot, pageHtml } from "./services";
import type { Env } from "./types";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export async function handleGateway(req: Request, env: Env, path: string[]): Promise<Response> {
  if (!env.GATEWAY_TOKEN || req.headers.get("Authorization") !== `Bearer ${env.GATEWAY_TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }
  const body: any = await req.json().catch(() => ({}));
  const runId = String(body.runId || "local");
  const host = String(body.host || "www.daytona.io");
  const role: Role =
    body.role === "crew" && body.taskId ? { role: "crew", runId, taskId: String(body.taskId), host }
    : body.role === "captain" ? { role: "captain", runId, userId: String(body.userId || "captain") }
    : { role: "firstmate", runId, host };
  switch (path[0]) {
    case "capture": {
      // {url, kind: "screenshot"|"html", width?, height?}
      if (!/^https?:\/\//.test(body.url || "")) return json({ error: "url required" }, 400);
      if (body.kind === "html") {
        const { html, tool } = await pageHtml(env, body.url);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "X-Tool": tool } });
      }
      const png = await anchorScreenshot(env, body.url, body.width || 1440, body.height || 900);
      return png ? new Response(png, { headers: { "Content-Type": "image/png", "X-Tool": "anchor" } }) : json({ error: "screenshot not observed" }, 502);
    }
    case "remember": {
      // {role, runId, taskId?, text, scope?: "site", observedAt?}: an observation or decision with its sources
      const site = body.scope === "site" ? `org/reversy/site/${host.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}` : undefined;
      const r = await rememberAs(env, role, String(body.text || "").slice(0, 20000), { scope: site, observedAt: body.observedAt });
      return json({ role: role.role, status: r.status, ...(r.status >= 400 ? { error: r.body.message } : {}) }, r.status >= 400 ? r.status : 200);
    }
    case "recall": {
      const r = await recallAs(env, role, String(body.query || ""), body.asOf);
      if (r.status >= 400) return json({ error: r.body.message }, r.status);
      return json({
        role: role.role, tier: r.body.tier,
        hits: (r.body.hits || []).map((h: any) => ({ text: h.text, at: h.occurredAt, source: h.source })),
      });
    }
    default:
      return json({ error: "unknown gateway route" }, 404);
  }
}

/** POST /sandboxes/:id/captain {text}: type the captain's message into the first mate's pane. */
export async function sendToFirstMate(env: Env, sandboxId: string, text: string) {
  const d = new Daytona(env);
  const clean = text.replace(/\r?\n/g, " ").slice(0, 8000);
  const quoted = `'${clean.replace(/'/g, `'\\''`)}'`;
  const r = await d.exec(sandboxId, `tmux send-keys -t fm:0 -l ${quoted} && sleep 0.5 && tmux send-keys -t fm:0 Enter`);
  if (r.exitCode !== 0) throw new Error(`first mate unreachable: ${r.result.slice(0, 200)}`);
}

/** GET /sandboxes/:id/screen: the first mate's current screen (for debugging and the canvas). */
export async function firstMateScreen(env: Env, sandboxId: string) {
  const d = new Daytona(env);
  return (await d.exec(sandboxId, "tmux capture-pane -p -t fm:0 | tail -60")).result;
}
