import { type CaptureEvent, CaptureRequest } from "../../shared/evidence";
import { AnchorError } from "./anchor";
import { CaptureError, captureRun } from "./capture";
import {
  evidenceIdPattern,
  runIdPattern,
  surrealBindings,
  surrealStore,
} from "./store";

export type EvidenceEnv = Partial<
  Record<"ANCHOR_API_KEY" | (typeof surrealBindings)[number], string>
>;

// A feature with a missing binding reports exactly which ones, never a faked result.
function requireBindings<K extends keyof EvidenceEnv>(
  env: EvidenceEnv,
  names: readonly K[],
): Record<K, string> | Response {
  const missing = names.filter((name) => !env[name]);
  return missing.length
    ? Response.json(
        { error: "Missing Worker bindings", missing },
        { status: 503 },
      )
    : (env as Record<K, string>);
}

const notFound = () =>
  Response.json({ error: "Evidence not found" }, { status: 404 });

// Handles the evidence routes, or returns null for any other path.
export async function handleEvidence(
  request: Request,
  env: EvidenceEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const capture = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/capture$/);
  const evidence = pathname.match(/^\/api\/v1\/evidence\/([^/]+)(\/content)?$/);

  if (capture && request.method === "POST") {
    const runId = decodeURIComponent(capture[1] as string);
    if (!runIdPattern.test(runId)) {
      return Response.json({ error: "Invalid run id" }, { status: 400 });
    }
    const parsed = CaptureRequest.safeParse(
      await request.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid capture request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const bound = requireBindings(env, ["ANCHOR_API_KEY", ...surrealBindings]);
    if (bound instanceof Response) return bound;
    // shortcut: events are returned in the response until the run API's event function lands on main.
    const events: CaptureEvent[] = [];
    try {
      const result = await captureRun(
        {
          anchorApiKey: bound.ANCHOR_API_KEY,
          store: surrealStore(bound),
          emit: (event) => {
            events.push(event);
          },
        },
        runId,
        parsed.data,
      );
      return Response.json(
        { ...result, events },
        { status: result.status === "captured" ? 200 : 202 },
      );
    } catch (error) {
      if (error instanceof CaptureError) {
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      }
      if (error instanceof AnchorError) {
        return Response.json({ error: error.message }, { status: 502 });
      }
      throw error;
    }
  }

  if (evidence && request.method === "GET") {
    const id = decodeURIComponent(evidence[1] as string);
    if (!evidenceIdPattern.test(id)) return notFound();
    const bound = requireBindings(env, surrealBindings);
    if (bound instanceof Response) return bound;
    const store = surrealStore(bound);
    const record = await store.getEvidence(id);
    if (!record) return notFound();
    if (!evidence[2]) return Response.json(record);
    const content = await store.getContent(id);
    if (!content) return notFound();
    return new Response(content, {
      headers: {
        "content-type": record.contentType,
        "x-content-hash": record.contentHash,
      },
    });
  }

  return null;
}
