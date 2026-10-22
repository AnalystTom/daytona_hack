import { WorkerEntrypoint } from "cloudflare:workers";
import { version } from "../../package.json";
import { type DaytonaEnv, handleSandboxRoute } from "./daytona/routes";
import { type EvidenceEnv, handleEvidence } from "./evidence/routes";
import { type ExampleEnv, handleExample } from "./example/routes";
import { handleOrchestrator, type OrchestratorEnv } from "./orchestrator/front";
import { recordRunEvent } from "./records/records";
import { handleRunsApi, type RunsEnv } from "./runs/api";
import { resolveStore, type StoreEnv } from "./store";
import { handleVerify, type VerifierEnv } from "./verifier/route";

export default {
  async fetch(
    request: Request,
    env: VerifierEnv & DaytonaEnv & EvidenceEnv & OrchestratorEnv & ExampleEnv,
  ) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/api/health") {
      return Response.json({ ok: true, version });
    }
    const verify = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/verify$/);
    if (request.method === "POST" && verify?.[1]) {
      return handleVerify(request, env, verify[1]);
    }
    // The saved example is public and read-only.
    const example = await handleExample(request, env);
    if (example) return example;
    const sandbox = await handleSandboxRoute(request, env);
    if (sandbox) return sandbox;
    // Evidence routes run before the run API, which 404s every other /api/v1/ path.
    const evidence = await handleEvidence(request, env);
    if (evidence) return evidence;
    // Run routes go to the orchestrator; the older run API below now only answers other paths.
    const orchestrator = await handleOrchestrator(request, env);
    if (orchestrator) return orchestrator;
    if (pathname.startsWith("/api/v1/")) return handleRunsApi(request, env);
    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<
  RunsEnv &
    VerifierEnv &
    DaytonaEnv &
    EvidenceEnv &
    OrchestratorEnv &
    ExampleEnv
>;

// The orchestrator's RECORDS service binding: run records into D1. Not reachable over HTTP.
export class Records extends WorkerEntrypoint<StoreEnv> {
  async record(input: unknown) {
    const resolved = resolveStore(this.env);
    if ("missing" in resolved) {
      throw new Error(`Run records need ${resolved.missing.join(", ")}`);
    }
    await recordRunEvent(resolved.store, input);
  }
}
