import { Failure, notConfigured } from "../runs/api";

// Cloudflare Access sits in front of the workspace and its API and signs each request it lets
// through with a JWT naming the user. Without both bindings, runs stay operator-only.
export interface AccessEnv {
  // The Zero Trust team domain, for example `myteam.cloudflareaccess.com`.
  ACCESS_TEAM_DOMAIN?: string;
  // The Access application's Application Audience (AUD) tag.
  ACCESS_AUD?: string;
}

export const ACCESS_HEADER = "cf-access-jwt-assertion";

type Jwk = JsonWebKey & { kid?: string };
type Keys = { keys: Map<string, CryptoKey>; fetchedAt: number };

const keyCache = new Map<string, Keys>();
// An unknown key id refetches the certs (Access rotates keys), at most this often.
const REFETCH_MS = 60_000;

const refused = (why: string) =>
  new Failure(
    401,
    "access_required",
    `Your Cloudflare Access sign-in ${why}. Reload the page to sign in again.`,
  );

// Returns the configured team domain and audience, or null when Access is not set up.
export function accessConfig(env: AccessEnv) {
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } = env;
  if (!team && !aud) return null;
  if (!team || !aud) {
    throw notConfigured([team ? "ACCESS_AUD" : "ACCESS_TEAM_DOMAIN"]);
  }
  return { team: team.replace(/^https?:\/\//, "").replace(/\/+$/, ""), aud };
}

// Verifies the Access JWT (RS256 signature against the team's certs, audience, issuer, expiry)
// and returns the user's email, lowercased.
export async function verifyAccessJwt(
  token: string,
  config: { team: string; aud: string },
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<string> {
  const [head = "", body = "", signature = ""] = token.split(".");
  const header = decode(head) as { alg?: unknown; kid?: unknown } | null;
  if (header?.alg !== "RS256" || typeof header.kid !== "string") {
    throw refused("could not be read");
  }
  const key = await signingKey(config.team, header.kid, fetcher);
  const valid =
    key !== undefined &&
    (await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      bytes(signature),
      new TextEncoder().encode(`${head}.${body}`),
    ));
  if (!valid) throw refused("has an invalid signature");
  const claims = decode(body) as {
    aud?: unknown;
    iss?: unknown;
    exp?: unknown;
    nbf?: unknown;
    email?: unknown;
  } | null;
  const audiences = [claims?.aud].flat();
  if (!audiences.includes(config.aud)) throw refused("is for another app");
  if (claims?.iss !== `https://${config.team}`) {
    throw refused("is from another team");
  }
  const now = Date.now() / 1000;
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    throw refused("has expired; reload the page to sign in again");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) {
    throw refused("is not valid yet");
  }
  if (typeof claims.email !== "string" || !claims.email.includes("@")) {
    throw refused("names no email");
  }
  return claims.email.toLowerCase();
}

async function signingKey(team: string, kid: string, fetcher: typeof fetch) {
  let cached = keyCache.get(team);
  if (
    !cached?.keys.has(kid) &&
    (!cached || Date.now() - cached.fetchedAt > REFETCH_MS)
  ) {
    cached = { keys: await fetchKeys(team, fetcher), fetchedAt: Date.now() };
    keyCache.set(team, cached);
  }
  return cached.keys.get(kid);
}

async function fetchKeys(team: string, fetcher: typeof fetch) {
  const response = await fetcher(`https://${team}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new Failure(
      503,
      "access_unavailable",
      "Cloudflare Access keys could not be fetched.",
      true,
    );
  }
  const { keys = [] } = (await response.json()) as { keys?: Jwk[] };
  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    imported.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, n: jwk.n, e: jwk.e },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  return imported;
}

function bytes(base64url: string) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

function decode(part: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes(part)));
  } catch {
    return null;
  }
}
