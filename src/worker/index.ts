import { version } from "../../package.json";
import { type DaytonaEnv, handleSandboxRoute } from "./daytona/routes";
import { handleVerify, type VerifierEnv } from "./verifier/route";

export default {
  async fetch(request, env) {
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
    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<VerifierEnv & DaytonaEnv>;
