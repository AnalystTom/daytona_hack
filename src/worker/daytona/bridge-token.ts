// A run sandbox holds only its own bridge token, derived from the Worker-wide BRIDGE_TOKEN,
// so a leak from one sandbox cannot post events into any other run. The run API's bridge routes
// verify a bridge request by deriving the same token for the run id in its URL.
export async function runBridgeToken(secret: string, runId: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(runId),
  );
  return [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
