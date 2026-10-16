import { version } from "../../package.json";
import { type DaytonaEnv, handleSandboxRoute } from "./daytona/routes";
import { type EvidenceEnv, handleEvidence } from "./evidence/routes";
import { handleRunsApi, type RunsEnv } from "./runs/api";
import { handleVerify, type VerifierEnv } from "./verifier/route";

export default {
  async fetch(request: Request, env: VerifierEnv & DaytonaEnv & EvidenceEnv) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/api/health") {
      return Response.json({ ok: true, version });
    }
    const verify = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/verify$/);
    if (request.method === "POST" && verify?.[1]) {
      return handleVerify(request, env, verify[1]);
    }
    const sandbox = await handleSandboxRoute(request, env);
    if (sandbox) return sandbox;
    // Evidence routes run before the run API, which 404s every other /api/v1/ path.
    const evidence = await handleEvidence(request, env);
    if (evidence) return evidence;
    if (pathname.startsWith("/api/v1/")) return handleRunsApi(request, env);
    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<RunsEnv & VerifierEnv & DaytonaEnv & EvidenceEnv>;
