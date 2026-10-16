import { z } from "zod";
import { CaptainInput, CreatePodRequest } from "../../shared/sandbox";
import { runBridgeToken } from "./bridge-token";
import { createDaytonaClient, DaytonaError } from "./client";
import {
  cleanupRun,
  createPod,
  DEFAULT_SNAPSHOT,
  type Deps,
  getRunSandbox,
  LifecycleError,
  type RunEnv,
  sendCaptainInput,
  startRunSandbox,
} from "./lifecycle";

export type DaytonaEnv = {
  SANDBOX_API_TOKEN?: string;
  DAYTONA_API_KEY?: string;
  DAYTONA_API_URL?: string;
  DAYTONA_SNAPSHOT?: string;
  OPENAI_API_KEY?: string;
  BRIDGE_TOKEN?: string;
};

const ROUTE =
  /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,64})\/(sandbox|sandbox\/messages|pods)$/;

const missing = (env: DaytonaEnv, names: (keyof DaytonaEnv)[]) =>
  names.filter((name) => !env[name]);

// Compares SHA-256 digests so the time taken does not reveal how much of the token matched.
async function sameSecret(given: string, expected: string) {
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function body<T>(request: Request, schema: z.ZodType<T>) {
  const text = await request.text();
  try {
    return schema.safeParse(text ? JSON.parse(text) : {});
  } catch {
    return schema.safeParse(undefined);
  }
}

// Run sandbox lifecycle: returns null when the path is not one of these routes.
export async function handleSandboxRoute(
  request: Request,
  env: DaytonaEnv,
  makeDeps: (env: DaytonaEnv) => Deps = (e) => ({
    daytona: createDaytonaClient({
      apiKey: e.DAYTONA_API_KEY ?? "",
      apiUrl: e.DAYTONA_API_URL,
    }),
    snapshot: e.DAYTONA_SNAPSHOT || DEFAULT_SNAPSHOT,
  }),
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = ROUTE.exec(url.pathname);
  if (!match) return null;
  const [, runId = "", resource] = match;
  const action = `${request.method} ${resource}`;
  const known = [
    "POST sandbox",
    "GET sandbox",
    "DELETE sandbox",
    "POST sandbox/messages",
    "POST pods",
  ];
  if (!known.includes(action)) {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // Starting a sandbox or a copy pod boots Firstmate, which needs every secret.
  const needsAll = action === "POST sandbox" || action === "POST pods";
  const absent = missing(
    env,
    needsAll
      ? [
          "SANDBOX_API_TOKEN",
          "DAYTONA_API_KEY",
          "OPENAI_API_KEY",
          "BRIDGE_TOKEN",
        ]
      : ["SANDBOX_API_TOKEN", "DAYTONA_API_KEY"],
  );
  if (absent.length) {
    return Response.json(
      { error: `Missing binding: ${absent.join(", ")}`, missing: absent },
      { status: 503 },
    );
  }
  // These routes spend money and instruct agents that hold secrets, so only trusted callers may use them.
  const auth = request.headers.get("Authorization") ?? "";
  if (
    !auth.startsWith("Bearer ") ||
    !(await sameSecret(auth.slice(7), env.SANDBOX_API_TOKEN ?? ""))
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const deps = makeDeps(env);
  const runEnv: RunEnv = {
    runId,
    apiUrl: url.origin,
    openaiApiKey: env.OPENAI_API_KEY ?? "",
    // Never the Worker-wide BRIDGE_TOKEN: the sandbox gets a token valid for this run only.
    bridgeToken: needsAll
      ? await runBridgeToken(env.BRIDGE_TOKEN ?? "", runId)
      : "",
  };

  try {
    switch (action) {
      case "POST sandbox":
        return Response.json(await startRunSandbox(deps, runEnv));
      case "GET sandbox": {
        const sandbox = await getRunSandbox(deps, runId);
        return sandbox
          ? Response.json(sandbox)
          : Response.json(
              { error: `Run ${runId} has no sandbox` },
              { status: 404 },
            );
      }
      case "DELETE sandbox": {
        const report = await cleanupRun(deps, runId);
        return Response.json(report, {
          status: report.status === "succeeded" ? 200 : 502,
        });
      }
      case "POST sandbox/messages": {
        const input = await body(request, CaptainInput);
        if (!input.success) {
          return Response.json(
            { error: z.prettifyError(input.error) },
            { status: 400 },
          );
        }
        await sendCaptainInput(deps, runId, input.data);
        return Response.json({ delivered: true }, { status: 202 });
      }
      default: {
        const input = await body(request, CreatePodRequest);
        if (!input.success) {
          return Response.json(
            { error: z.prettifyError(input.error) },
            { status: 400 },
          );
        }
        return Response.json(
          await createPod(deps, runEnv, input.data.fromSandboxId),
          { status: 201 },
        );
      }
    }
  } catch (error) {
    if (error instanceof LifecycleError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DaytonaError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    throw error;
  }
}
