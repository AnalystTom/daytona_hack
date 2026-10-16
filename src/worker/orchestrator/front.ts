import { z } from "zod";
import { ChatMessageRequest, CreateRunRequest } from "../../shared/runs";
import {
  checkToken,
  errorResponse,
  Failure,
  notConfigured,
  readJson,
} from "../runs/api";
import { checkTargetUrl } from "../runs/url";

// The reversy-orchestrator Worker has no public address; this Worker is its front door.
export interface OrchestratorEnv {
  ORCHESTRATOR?: Fetcher;
  OPERATOR_TOKEN?: string;
}

const OverrideRequest = z.object({
  taskId: z.string().min(1).max(100),
  verdict: z.enum(["approve", "reject"]),
  reason: z.string().trim().max(2000).default(""),
});

const RUNS = /^\/api\/v1\/runs(?:\/([\w-]{1,100})(?:\/(.+))?)?$/;
const EVIDENCE = /^evidence\/[\w-]{1,100}$/;
const OPERATOR_PREFIX = "/api/v1/orchestrator";
const GATEWAY_PREFIX = "/api/v1/gateway";

// Handles /api/v1/runs/* (the workspace's run API), /api/v1/orchestrator/* (operator testing)
// and /api/v1/gateway/* (the run sandbox's network gateway).
// Every run POST starts, steers or stops paid work, so each one needs the operator token.
export async function handleOrchestrator(
  request: Request,
  env: OrchestratorEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const operator =
    url.pathname === OPERATOR_PREFIX ||
    url.pathname.startsWith(`${OPERATOR_PREFIX}/`);
  const run = url.pathname.match(RUNS);
  const gateway = url.pathname.startsWith(`${GATEWAY_PREFIX}/`);
  if (!operator && !run && !gateway) return null;
  try {
    if (operator || (run && request.method === "POST")) {
      await checkToken(request, env, "OPERATOR_TOKEN");
    }
    if (!env.ORCHESTRATOR) throw notConfigured(["ORCHESTRATOR"]);
    if (gateway) {
      // The orchestrator checks the sandbox's own GATEWAY_TOKEN, so the header goes through as sent.
      if (request.method !== "POST") throw notFound();
      const path = `/gateway${url.pathname.slice(GATEWAY_PREFIX.length)}`;
      return await passThrough(request, env.ORCHESTRATOR, path);
    }
    if (operator) {
      const path = url.pathname.slice(OPERATOR_PREFIX.length) || "/";
      return await passThrough(
        request,
        env.ORCHESTRATOR,
        `${path}${url.search}`,
      );
    }
    return await runRoute(request, env.ORCHESTRATOR, url, run?.[1], run?.[2]);
  } catch (error) {
    return errorResponse(request, error);
  }
}

// Forwards the request as is, bearer token included: the orchestrator's /sandboxes and
// /gateway routes check it themselves.
async function passThrough(
  request: Request,
  orchestrator: Fetcher,
  path: string,
) {
  const response = await orchestrator.fetch(`https://orchestrator${path}`, {
    method: request.method,
    headers: request.headers,
    body: ["GET", "HEAD"].includes(request.method)
      ? undefined
      : await request.arrayBuffer(),
  });
  return withoutCors(response);
}

async function runRoute(
  request: Request,
  orchestrator: Fetcher,
  url: URL,
  runId: string | undefined,
  action = "",
): Promise<Response> {
  const { method } = request;
  const call = (path: string, body?: unknown) =>
    forward(orchestrator, method, path, body);

  if (runId === undefined) {
    if (method !== "POST") throw notFound();
    const { url: target, goal } = await readJson(request, CreateRunRequest);
    const checked = checkTargetUrl(target);
    if ("error" in checked) {
      throw new Failure(400, "invalid_url", checked.error);
    }
    return call("/runs", { url: checked.url, goal });
  }
  const base = `/runs/${runId}`;
  if (method === "GET") {
    if (action === "") {
      const response = await call(base);
      // A run id the orchestrator never saw answers 200 with an empty body.
      if ((await response.clone().text()) === "") {
        throw new Failure(404, "run_not_found", `Run ${runId} not found.`);
      }
      return response;
    }
    if (action === "events") {
      const since = url.searchParams.get("since") ?? "0";
      if (!/^\d{1,10}$/.test(since)) {
        throw new Failure(
          400,
          "invalid_since",
          "since must be an event number.",
        );
      }
      return call(`${base}/events?since=${since}`);
    }
    if (EVIDENCE.test(action)) return call(`${base}/${action}`);
  }
  if (method === "POST") {
    if (action === "messages") {
      return call(
        `${base}/messages`,
        await readJson(request, ChatMessageRequest),
      );
    }
    if (action === "override") {
      return call(`${base}/override`, await readJson(request, OverrideRequest));
    }
    if (["approve", "build", "stop"].includes(action)) {
      return call(`${base}/${action}`, {});
    }
  }
  throw notFound();
}

const notFound = () => new Failure(404, "not_found", "No such route.");

async function forward(
  orchestrator: Fetcher,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const response = await orchestrator.fetch(`https://orchestrator${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.ok) return withoutCors(response);
  const reply = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  const message =
    typeof reply?.error === "string"
      ? reply.error
      : `The orchestrator answered ${response.status}.`;
  // The orchestrator reports refused actions (wrong phase, unknown task) as 500.
  throw new Failure(
    response.status === 404 ? 404 : 502,
    "orchestrator_error",
    message,
  );
}

// The orchestrator allows any origin; only this site may read its replies.
function withoutCors(response: Response) {
  const headers = new Headers();
  const type = response.headers.get("content-type");
  if (type) headers.set("content-type", type);
  return new Response(response.body, { status: response.status, headers });
}
