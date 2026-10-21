import { CaptureRequest } from "../../shared/evidence";
import { resolveStore, type StoreEnv, surrealBindings } from "../store";
import type { SurrealRunStore } from "../store/surreal";
import { AnchorError } from "./anchor";
import { CaptureError, captureRun } from "./capture";
import { evidenceIdPattern, runIdPattern, surrealStore } from "./store";

export type EvidenceEnv = StoreEnv &
  Partial<Record<"OPERATOR_TOKEN" | "ANCHOR_API_KEY", string>>;

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

const decode = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
};

const encoder = new TextEncoder();
const digest = async (value: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

async function authorized(request: Request, token: string) {
  const header = request.headers.get("authorization") ?? "";
  const [given, expected] = await Promise.all([
    digest(header),
    digest(`Bearer ${token}`),
  ]);
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= (given[i] as number) ^ (expected[i] as number);
  return diff === 0;
}

// Bindings are checked before this, so the store always resolves.
const runStore = (env: StoreEnv) =>
  (resolveStore(env) as { store: SurrealRunStore }).store;

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
  const isCapture = capture && request.method === "POST";
  const isEvidence = evidence && request.method === "GET";
  if (!isCapture && !isEvidence) return null;

  const operator = requireBindings(env, ["OPERATOR_TOKEN"]);
  if (operator instanceof Response) return operator;
  if (!(await authorized(request, operator.OPERATOR_TOKEN))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isCapture) {
    const runId = decode(capture[1] as string);
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
    const db = runStore(bound);
    if (!(await db.getRun(runId))) {
      return Response.json({ error: "Run not found" }, { status: 404 });
    }
    try {
      const result = await captureRun(
        {
          anchorApiKey: bound.ANCHOR_API_KEY,
          store: surrealStore(db),
          emit: async (event) => {
            await db.appendEvents(runId, [
              {
                schemaVersion: 1,
                eventId: crypto.randomUUID(),
                sequence: 0,
                runId,
                timestamp: new Date().toISOString(),
                ...event,
              },
            ]);
          },
        },
        runId,
        parsed.data,
      );
      return Response.json(result, {
        status: result.status === "captured" ? 200 : 202,
      });
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

  if (isEvidence) {
    const id = decode(evidence[1] as string);
    if (!evidenceIdPattern.test(id)) return notFound();
    const bound = requireBindings(env, surrealBindings);
    if (bound instanceof Response) return bound;
    const store = surrealStore(runStore(bound));
    const record = await store.getEvidence(id);
    if (!record) return notFound();
    if (!evidence[2]) return Response.json(record);
    const content = await store.getContent(id);
    if (!content) return notFound();
    return new Response(content, {
      headers: {
        "content-type": record.contentType,
        "x-content-hash": record.contentHash,
        // Captured pages are site content: never let them run on Reversy's origin.
        "content-security-policy": "sandbox; default-src 'none'",
        "x-content-type-options": "nosniff",
      },
    });
  }

  return null;
}
