import { describe, expect, it } from "vitest";
import { checkTargetUrl } from "./url";

describe("checkTargetUrl", () => {
  it.each([
    ["https://example.com", "https://example.com/"],
    [
      "https://www.daytona.io/pricing?x=1",
      "https://www.daytona.io/pricing?x=1",
    ],
    ["https://93.184.216.34:8443/", "https://93.184.216.34:8443/"],
    ["https://[2606:4700::1111]/", "https://[2606:4700::1111]/"],
    ["https://172.32.0.1/", "https://172.32.0.1/"],
  ])("accepts %s", (input, url) => {
    expect(checkTargetUrl(input)).toEqual({ url });
  });

  it.each([
    ["not a url", "not valid"],
    ["http://example.com", "https"],
    ["ftp://example.com", "https"],
    ["https://user:pass@example.com", "credentials"],
    ["https://user@example.com", "credentials"],
    ["https://localhost", "public"],
    ["https://app.localhost", "public"],
    ["https://printer.local", "public"],
    ["https://db.internal", "public"],
    ["https://intranet", "public"],
    ["https://127.0.0.1", "public"],
    ["https://2130706433", "public"], // 127.0.0.1 as a decimal integer
    ["https://0x7f.1", "public"],
    ["https://10.1.2.3", "public"],
    ["https://172.16.0.1", "public"],
    ["https://192.168.1.1", "public"],
    ["https://169.254.169.254", "public"],
    ["https://100.64.0.1", "public"],
    ["https://0.0.0.0", "public"],
    ["https://[::1]", "public"],
    ["https://[::]", "public"],
    ["https://[::ffff:127.0.0.1]", "public"],
    ["https://[fd00::1]", "public"],
    ["https://[fe80::1]", "public"],
  ])("rejects %s", (input, reason) => {
    const result = checkTargetUrl(input);
    expect(result).toHaveProperty("error");
    expect("error" in result && result.error).toContain(reason);
  });
});
