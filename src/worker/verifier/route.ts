import { VerifyRequest, type VerifyResponse } from "../../shared/verifier";
import { VERIFIER_MODEL, VerifierError, verify } from "./verify";

export interface VerifierEnv {
  ANTHROPIC_API_KEY?: string;
  VERIFIER_TOKEN?: string;
}

// Constant-time compare: hashing first gives equal-length inputs, so timing reveals nothing.
async function tokenMatches(given: string, expected: string): Promise<boolean> {
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// POST /api/v1/runs/:id/verify. There is no run API yet to record the verdict as an
// event, so it returns the verdict; the run API can call verify() directly once it exists.
// Callers authenticate with "Authorization: Bearer <VERIFIER_TOKEN>"; verify() itself needs no token.
export async function handleVerify(
  request: Request,
  env: VerifierEnv,
  runId: string,
): Promise<Response> {
  if (!env.VERIFIER_TOKEN) {
    return Response.json(
      { error: "Verifier unavailable: VERIFIER_TOKEN binding is missing" },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!(await tokenMatches(given, env.VERIFIER_TOKEN))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "Verifier unavailable: ANTHROPIC_API_KEY binding is missing" },
      { status: 503 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = VerifyRequest.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid verify request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const verdict = await verify(env.ANTHROPIC_API_KEY, parsed.data);
    const response: VerifyResponse = {
      runId,
      kind: parsed.data.kind,
      model: VERIFIER_MODEL,
      ...verdict,
    };
    return Response.json(response);
  } catch (error) {
    if (error instanceof VerifierError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    throw error;
  }
}
