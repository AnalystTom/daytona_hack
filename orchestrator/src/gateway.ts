// Network gateway for the run sandbox. On Daytona Tier 1/2 the sandbox cannot reach Anchor or SurrealDB,
// so Firstmate's crew calls these routes (via the `reversy` CLI) instead. Keys stay on Cloudflare either way:
// the sandbox only holds GATEWAY_TOKEN. Also relays captain (user) messages into the first mate's tmux pane.
import { Daytona } from "./daytona";
import { recall, remember } from "./services";
import type { Env } from "./types";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function handleGateway(
  req: Request,
  env: Env,
  path: string[],
): Promise<Response> {
  if (
    !env.GATEWAY_TOKEN ||
    req.headers.get("Authorization") !== `Bearer ${env.GATEWAY_TOKEN}`
  ) {
    return json({ error: "unauthorized" }, 401);
  }
  const body: any = await req.json().catch(() => ({}));
  const scope = `org/reversy/run/${String(body.runId || "local").slice(0, 40)}`;
  switch (path[0]) {
    case "capture": {
      // {runId, url}: a desktop screenshot of a page in the run's approved scope
      if (!body.runId || !/^https?:\/\//.test(body.url || ""))
        return json({ error: "runId and url required" }, 400);
      const run = env.RUNS.get(env.RUNS.idFromName(String(body.runId))) as any;
      const out = await run.gatewayCapture(body.url);
      if (out.error) return json({ error: out.error }, out.status);
      return new Response(out.png, {
        headers: { "Content-Type": "image/png", "X-Tool": "anchor" },
      });
    }
    case "remember":
      // {text, observedAt?} — an observation or decision with its sources written into the text
      await remember(
        env,
        scope,
        String(body.text || "").slice(0, 20000),
        body.observedAt,
      );
      return json({ ok: true, scope });
    case "recall":
      return json({
        context: await recall(env, scope, String(body.query || "")),
      });
    default:
      return json({ error: "unknown gateway route" }, 404);
  }
}

/** POST /sandboxes/:id/captain {text}: type the captain's message into the first mate's pane. */
export async function sendToFirstMate(
  env: Env,
  sandboxId: string,
  text: string,
) {
  const d = new Daytona(env);
  const clean = text.replace(/\r?\n/g, " ").slice(0, 8000);
  const quoted = `'${clean.replace(/'/g, `'\\''`)}'`;
  const r = await d.exec(
    sandboxId,
    `tmux send-keys -t fm:0 -l ${quoted} && sleep 0.5 && tmux send-keys -t fm:0 Enter`,
  );
  if (r.exitCode !== 0)
    throw new Error(`first mate unreachable: ${r.result.slice(0, 200)}`);
}

/** GET /sandboxes/:id/screen: the first mate's current screen (for debugging and the canvas). */
export async function firstMateScreen(env: Env, sandboxId: string) {
  const d = new Daytona(env);
  return (await d.exec(sandboxId, "tmux capture-pane -p -t fm:0 | tail -60"))
    .result;
}
