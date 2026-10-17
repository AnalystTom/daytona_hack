import { runBridgeToken } from "../daytona/bridge-token";
import { checkToken, Failure, notConfigured, sameSecret } from "../runs/api";
import {
  ACCESS_HEADER,
  type AccessEnv,
  accessConfig,
  verifyAccessJwt,
} from "./access";

// __Host- keeps the cookie on this exact host, Secure and Path=/.
export const SESSION_COOKIE = "__Host-reversy_visitor";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const VISITOR_ID = /^[\w-]{36}$/;

const foreignOrigin = () =>
  new Failure(403, "forbidden_origin", "Requests must come from this site.");

// HMAC of the visitor id, keyed by OPERATOR_TOKEN (never sent to the browser): rotating the
// token signs every visitor out.
const sign = (secret: string, id: string) =>
  runBridgeToken(secret, `visitor:${id}`);

// Who is calling. `owner` is the run owner: the Access email, or "anon:<id>" for a visitor's
// anonymous session; undefined for an operator bearer, who may act on any run. `setCookie`
// is set when a new visitor needs their session cookie.
export interface Caller {
  owner?: string;
  setCookie?: string;
}

export async function checkCaller(
  request: Request,
  env: { OPERATOR_TOKEN?: string } & AccessEnv,
  fetcher?: typeof fetch,
): Promise<Caller> {
  const origin = request.headers.get("origin");
  const own = origin === new URL(request.url).origin;
  if (origin !== null && !own) throw foreignOrigin();
  const access = accessConfig(env);
  let caller: Caller;
  if (access) {
    const jwt = request.headers.get(ACCESS_HEADER);
    if (!jwt) {
      throw new Failure(
        401,
        "access_required",
        "Sign in through Cloudflare Access in a new tab, then return to your workspace and try again.",
      );
    }
    caller = { owner: await verifyAccessJwt(jwt, access, fetcher) };
  } else if (request.headers.has("authorization")) {
    await checkToken(request, env, "OPERATOR_TOKEN");
    return {};
  } else {
    if (!env.OPERATOR_TOKEN) throw notConfigured(["OPERATOR_TOKEN"]);
    caller = await visitor(request, env.OPERATOR_TOKEN);
  }
  if (!["GET", "HEAD"].includes(request.method) && !own) throw foreignOrigin();
  return caller;
}

// A visitor's own cookie names their anonymous session; anything else gets a fresh one.
async function visitor(request: Request, secret: string): Promise<Caller> {
  const cookie = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  const [id = "", signature = ""] = (cookie ?? "").split(".");
  if (
    VISITOR_ID.test(id) &&
    (await sameSecret(signature, await sign(secret, id)))
  ) {
    return { owner: `anon:${id}` };
  }
  const fresh = crypto.randomUUID();
  return {
    owner: `anon:${fresh}`,
    setCookie: `${SESSION_COOKIE}=${fresh}.${await sign(secret, fresh)}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`,
  };
}
