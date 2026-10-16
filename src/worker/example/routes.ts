import { z } from "zod";
import type { OrchestratorEnv } from "../orchestrator/front";
import {
  checkToken,
  errorResponse,
  Failure,
  notConfigured,
  readJson,
} from "../runs/api";
import { resolveStore, type StoreEnv } from "../store";
import {
  EXAMPLE_ID,
  exportRun,
  loadMedia,
  loadSnapshot,
  saveSnapshot,
  surrealExampleStore,
} from "./snapshot";

export type ExampleEnv = OrchestratorEnv & StoreEnv;

const SaveRequest = z.object({ runId: z.string().regex(EXAMPLE_ID) });
const ROUTE = /^\/api\/v1\/example(?:\/evidence\/([^/]+))?$/;

// GET /api/v1/example and /api/v1/example/evidence/:id are public and read-only: the saved
// copy cannot reach the run, so nothing here can steer, approve, build or spend.
// POST /api/v1/example {runId} (operator bearer) saves a finished run as the example.
export async function handleExample(
  request: Request,
  env: ExampleEnv,
): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(ROUTE);
  if (!match) return null;
  try {
    const resolved = resolveStore(env);
    const store =
      "store" in resolved ? surrealExampleStore(resolved.store) : undefined;
    const evidenceId = match[1];
    if (request.method === "POST" && evidenceId === undefined) {
      await checkToken(request, env, "OPERATOR_TOKEN");
      if (!env.ORCHESTRATOR) throw notConfigured(["ORCHESTRATOR"]);
      if (!store)
        throw notConfigured((resolved as { missing: string[] }).missing);
      const { runId } = await readJson(request, SaveRequest);
      const { snapshot, files } = await exportRun(env.ORCHESTRATOR, runId);
      await saveSnapshot(store, snapshot, files);
      return Response.json({
        runId,
        events: snapshot.events.length,
        media: snapshot.media,
        savedAt: snapshot.savedAt,
      });
    }
    if (request.method !== "GET") {
      throw new Failure(405, "read_only", "The example run is read-only.");
    }
    if (!store)
      throw notConfigured((resolved as { missing: string[] }).missing);
    const snapshot = await loadSnapshot(store);
    if (!snapshot) {
      throw new Failure(404, "no_example", "No example run has been saved.");
    }
    if (evidenceId === undefined) {
      return Response.json(snapshot, {
        headers: { "cache-control": "public, max-age=60" },
      });
    }
    const file = await loadMedia(store, snapshot, evidenceId);
    if (!file) throw new Failure(404, "not_found", "No such evidence file.");
    return new Response(file.bytes, {
      headers: {
        "content-type": file.contentType,
        // Captured site content never runs as a page here.
        "content-security-policy": "sandbox; default-src 'none'",
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=300",
      },
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}
