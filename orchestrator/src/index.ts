// HTTP surface for the backend (or a service binding). One Durable Object per run.
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
      if (req.method === "GET" && action === "evidence") {
        const blob = await run.evidenceBlob(parts[3]);
        return blob
          ? new Response(blob, { headers: { "Content-Type": "image/png" } })
          : json({ error: "not found" }, 404);
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
  "POST /runs {url, goal} -> run state (first look + first chat reply)",
  "GET  /runs/:id -> state {phase, spec, chat, evidence, tasks, previewUrl}",
  "GET  /runs/:id/events?since=N -> [{seq, ts, type, data}]",
  "GET  /runs/:id/evidence/:evId -> screenshot png",
  "POST /runs/:id/messages {text}",
  "POST /runs/:id/approve -> inspect + plan (async; watch events)",
  "POST /runs/:id/build -> start build (async)",
  "POST /runs/:id/stop",
  "POST /runs/:id/override {taskId, verdict, reason}",
];
