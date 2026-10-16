// HTTP surface for the backend (or a service binding). One Durable Object per run.
import { firstMateScreen, handleGateway, sendToFirstMate } from "./gateway";
import type { Env } from "./types";

export { Run } from "./run";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // runs/:id/:action/:arg
    if (req.method === "OPTIONS")
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "*",
        },
      });
    if (parts[0] === "gateway" && req.method === "POST") {
      try {
        return await handleGateway(req, env, parts.slice(1));
      } catch (e: any) {
        return json({ error: String(e?.message || e) }, 502);
      }
    }
    if (parts[0] === "sandboxes" && parts[1]) {
      // captain relay: operator-only (the backend holds OPERATOR_TOKEN)
      if (
        !env.OPERATOR_TOKEN ||
        req.headers.get("Authorization") !== `Bearer ${env.OPERATOR_TOKEN}`
      )
        return json({ error: "unauthorized" }, 401);
      try {
        if (req.method === "POST" && parts[2] === "captain") {
          const { text } = (await req.json()) as { text: string };
          await sendToFirstMate(env, parts[1], text);
          return json({ ok: true });
        }
        if (req.method === "GET" && parts[2] === "screen")
          return new Response(await firstMateScreen(env, parts[1]));
      } catch (e: any) {
        return json({ error: String(e?.message || e) }, 502);
      }
      return json({ error: "not found" }, 404);
    }
    if (parts[0] !== "runs")
      return json({ service: "reversy-orchestrator", routes: ROUTES });

    try {
      const body: any =
        req.method === "POST" ? await req.json().catch(() => ({})) : {};
      if (parts.length === 1 && req.method === "POST") {
        if (!body.url) return json({ error: "url required" }, 400);
        const id = crypto.randomUUID();
        const run = env.RUNS.get(env.RUNS.idFromName(id)) as any;
        return json(await run.start(id, body.url, body.goal || ""), 201);
      }
      const run = env.RUNS.get(env.RUNS.idFromName(parts[1])) as any;
      const action = parts[2] || "";
      if (req.method === "GET" && action === "")
        return json(await run.getState());
      if (req.method === "GET" && action === "events")
        return json(
          await run.events(parseInt(url.searchParams.get("since") || "0", 10)),
        );
      if (req.method === "GET" && action === "preview") {
        const url = await run.previewLink();
        return url
          ? json({ url })
          : json(
              {
                error:
                  "No preview: the build has not served one, or the run stopped.",
              },
              404,
            );
      }
      if (req.method === "GET" && action === "evidence") {
        const file = await run.evidenceFile(parts[3]);
        return file
          ? new Response(file.content, {
              headers: {
                "Content-Type": file.contentType,
                // Captured pages are site content: they must never run as a page.
                "Content-Security-Policy": "sandbox; default-src 'none'",
                "X-Content-Type-Options": "nosniff",
              },
            })
          : json({ error: "not found" }, 404);
      }
      if (req.method === "POST" && action === "sign-in") {
        if (!parts[3]) return json(await run.startSignIn());
        if (parts[3] === "resume") return json(await run.resumeSignIn());
        if (parts[3] === "skip") return json(await run.skipSignIn());
      }
      if (req.method === "POST" && action === "messages")
        return json(await run.message(body.text));
      if (req.method === "POST" && action === "approve")
        return json(await run.approveSpec());
      if (req.method === "POST" && action === "build")
        return json(await run.startBuild());
      if (req.method === "POST" && action === "stop")
        return json(await run.stop());
      if (req.method === "POST" && action === "override")
        return json(
          await run.override(body.taskId, body.verdict, body.reason || ""),
        );
      return json({ error: "not found", routes: ROUTES }, 404);
    } catch (e: any) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

const ROUTES = [
  "POST /gateway/capture {runId, url} -> desktop screenshot png (Bearer GATEWAY_TOKEN, from the sandbox; approved pages only)",
  "POST /gateway/remember {runId, text, observedAt?} / POST /gateway/recall {runId, query} (Bearer GATEWAY_TOKEN)",
  "POST /sandboxes/:id/captain {text} / GET /sandboxes/:id/screen (Bearer OPERATOR_TOKEN, from the backend)",
  "POST /runs {url, goal} -> run state (first look + first chat reply)",
  "GET  /runs/:id -> state {phase, spec, chat, evidence, tasks, previewUrl}",
  "GET  /runs/:id/preview -> {url}: a 30-minute signed link to the private sandbox preview",
  "GET  /runs/:id/events?since=N -> [{seq, ts, type, data}]",
  "GET  /runs/:id/evidence/:evId -> evidence file (png, mp4, html or json)",
  "POST /runs/:id/messages {text}",
  "POST /runs/:id/approve -> inspect + plan (async; watch events)",
  "POST /runs/:id/sign-in -> {liveViewUrl} (phase awaiting_sign_in: the user signs in in Anchor's live view)",
  "POST /runs/:id/sign-in/resume -> capture the stopped pages signed in, then plan (async)",
  "POST /runs/:id/sign-in/skip -> plan without the stopped pages (async)",
  "POST /runs/:id/build -> start build (async)",
  "POST /runs/:id/stop",
  "POST /runs/:id/override {taskId, verdict, reason}",
];
