// Test helpers: a Cloudflare Access team with one signing key, serving its certs like Access does.

export const TEAM = "reversy-test.cloudflareaccess.com";
export const AUD = "aud-for-reversy";

const keys = (await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);

export const certsFetches: string[] = [];

export const certs: typeof fetch = async (input) => {
  certsFetches.push(String(input));
  return String(input) === `https://${TEAM}/cdn-cgi/access/certs`
    ? Response.json({ keys: [{ ...publicJwk, kid: "k1" }] })
    : new Response("not found", { status: 404 });
};

const encode = (data: Uint8Array | string) =>
  btoa(
    typeof data === "string"
      ? data
      : String.fromCharCode(...new Uint8Array(data)),
  )
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

// A JWT shaped like Access's; `claims` overrides the defaults (valid for an hour).
export async function accessJwt(
  claims: Record<string, unknown> = {},
  kid = "k1",
) {
  const now = Math.floor(Date.now() / 1000);
  const head = encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = encode(
    JSON.stringify({
      aud: [AUD],
      iss: `https://${TEAM}`,
      email: "ada@example.com",
      iat: now,
      nbf: now,
      exp: now + 3600,
      ...claims,
    }),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${encode(new Uint8Array(signature))}`;
}
