import { z } from "zod";
import { runBridgeToken } from "../daytona/bridge-token";
import {
  checkToken,
  errorResponse,
  Failure,
  notConfigured,
  readJson,
  sameSecret,
} from "../runs/api";
import {
  ACCESS_HEADER,
  type AccessEnv,
  accessConfig,
  verifyAccessJwt,
} from "./access";

// __Host- keeps the cookie on this exact host, Secure and Path=/.
export const SESSION_COOKIE = "__Host-reversy_session";
const SESSION_SECONDS = 12 * 60 * 60;

const SessionRequest = z.object({ token: z.string().min(1).max(500) });

const foreignOrigin = () =>
  new Failure(403, "forbidden_origin", "Requests must come from this site.");

// HMAC of the expiry, keyed by OPERATOR_TOKEN: rotating the token signs every session out.
const sign = (secret: string, expires: number) =>
  runBridgeToken(secret, `session:${expires}`);

// POST /api/v1/session swaps the operator token for a signed HttpOnly cookie; DELETE signs out.
export async function handleSession(
  request: Request,
  env: { OPERATOR_TOKEN?: string } & AccessEnv,
): Promise<Response> {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin) {
      throw foreignOrigin();
    }
    if (request.method === "DELETE") return session("", 0);
    if (request.method !== "POST") {
      throw new Failure(405, "method_not_allowed", "Use POST or DELETE.");
    }
    if (accessConfig(env)) {
      throw new Failure(
        401,
        "access_required",
        "Sign in through Cloudflare Access in a new tab, then return to your workspace and try again.",
      );
    }
    if (!env.OPERATOR_TOKEN) throw notConfigured(["OPERATOR_TOKEN"]);
    const { token } = await readJson(request, SessionRequest);
    if (!(await sameSecret(token, env.OPERATOR_TOKEN))) {
      throw new Failure(401, "unauthorized", "The operator token was refused.");
    }
    const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const signature = await sign(env.OPERATOR_TOKEN, expires);
    return session(`${expires}.${signature}`, SESSION_SECONDS);
  } catch (error) {
    return errorResponse(request, error);
  }
}

const session = (value: string, maxAge: number) =>
  new Response(null, {
    status: 204,
    headers: {
      "set-cookie": `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`,
    },
  });

export async function checkCaller(
  request: Request,
  env: { OPERATOR_TOKEN?: string } & AccessEnv,
  fetcher?: typeof fetch,
): Promise<string | undefined> {
  const origin = request.headers.get("origin");
  const own = origin === new URL(request.url).origin;
  if (origin !== null && !own) throw foreignOrigin();
  const access = accessConfig(env);
  let email: string | undefined;
  if (access) {
    const jwt = request.headers.get(ACCESS_HEADER);
    if (!jwt) {
      throw new Failure(
        401,
        "access_required",
        "Sign in through Cloudflare Access in a new tab, then return to your workspace and try again.",
      );
    }
    email = await verifyAccessJwt(jwt, access, fetcher);
  } else if (request.headers.has("authorization")) {
    await checkToken(request, env, "OPERATOR_TOKEN");
    return undefined;
  } else {
    if (!env.OPERATOR_TOKEN) throw notConfigured(["OPERATOR_TOKEN"]);
    if (!(await validSession(request, env.OPERATOR_TOKEN))) {
      throw new Failure(
        401,
        "operator_token_required",
        "Sign in with the operator token to use runs.",
      );
    }
  }
  if (!["GET", "HEAD"].includes(request.method) && !own) throw foreignOrigin();
  return email;
}

async function validSession(request: Request, secret: string) {
  const cookie = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  const [expiry = "", signature = ""] = (cookie ?? "").split(".");
  const expires = Number(expiry);
  if (!/^\d{1,12}$/.test(expiry) || expires <= Date.now() / 1000) return false;
  return sameSecret(signature, await sign(secret, expires));
}
