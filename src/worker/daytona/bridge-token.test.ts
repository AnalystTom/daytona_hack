import { describe, expect, it } from "vitest";
import { runBridgeToken } from "./bridge-token";

describe("runBridgeToken", () => {
  it("is HMAC-SHA256 of the run id under BRIDGE_TOKEN, as hex", async () => {
    // RFC 4231 test case 2.
    expect(await runBridgeToken("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("differs per run and never equals the Worker-wide secret", async () => {
    const one = await runBridgeToken("worker-secret", "run-1");
    expect(one).not.toBe(await runBridgeToken("worker-secret", "run-2"));
    expect(one).not.toBe("worker-secret");
    expect(one).toMatch(/^[0-9a-f]{64}$/);
  });
});
