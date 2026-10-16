import { describe, expect, it, vi } from "vitest";
import { deliver, parseBrief, type RunClient, takeIncomingBrief } from "./chat";

const notConnected = {
  ok: false,
  error: "not_connected",
  detail: "The run service is not available yet.",
} as const;

describe("parseBrief", () => {
  it("splits the URL from the goal", () => {
    expect(
      parseBrief("Rebuild https://www.daytona.io/, only the hero."),
    ).toEqual({
      url: "https://www.daytona.io/",
      goal: "Rebuild, only the hero.",
    });
    expect(parseBrief("copy www.daytona.io")).toEqual({
      url: "https://www.daytona.io",
      goal: "copy",
    });
  });

  it("gives a goal when the brief is only a URL", () => {
    expect(parseBrief("https://example.com")).toEqual({
      url: "https://example.com",
      goal: "Rebuild this website.",
    });
  });

  it("accepts a bare domain, with or without a path", () => {
    expect(parseBrief("wikipedia.com")).toEqual({
      url: "https://wikipedia.com",
      goal: "Rebuild this website.",
    });
    expect(parseBrief("en.wikipedia.org/wiki/Cloud")).toEqual({
      url: "https://en.wikipedia.org/wiki/Cloud",
      goal: "Rebuild this website.",
    });
    expect(
      parseBrief("Rebuild goldmansachs.com/insights, only the header."),
    ).toEqual({
      url: "https://goldmansachs.com/insights",
      goal: "Rebuild, only the header.",
    });
    expect(parseBrief("copy wikipedia.com.")).toEqual({
      url: "https://wikipedia.com",
      goal: "copy.",
    });
  });

  it("does not treat emails or file names as sites", () => {
    expect(parseBrief("mail me at tom@example.com")).toBeUndefined();
    expect(parseBrief("see report.pdf and main.js")).toBeUndefined();
  });

  it.each([
    "example.com:8443/dashboard",
    "example.com?view=mobile",
    "example.com#pricing",
    "example.com:8443/dashboard?view=mobile#pricing",
    "www.example.com:8443/dashboard?view=mobile#pricing",
  ])("preserves the complete bare address %s", (address) => {
    expect(parseBrief(`Rebuild ${address}, only the header.`)).toEqual({
      url: `https://${address}`,
      goal: "Rebuild, only the header.",
    });
  });

  it.each([
    "shop.com.auction",
    "example.com:invalid/dashboard",
    "bücher.de",
    "example.com+tag@example.org",
    "www.example.com+tag@example.org",
    "www.shop.com.auction",
    "example.com/path@name",
    "example.com?email=tom@example.org",
    "example.com#tom@example.org",
  ])("rejects the complete unsupported token: %s", (address) => {
    expect(parseBrief(`Rebuild ${address}.`)).toBeUndefined();
  });

  it("continues to the next complete address after rejected tokens", () => {
    expect(
      parseBrief("bücher.de example.com+tag@example.org wikipedia.com"),
    ).toEqual({
      url: "https://wikipedia.com",
      goal: "bücher.de example.com+tag@example.org",
    });
  });

  it.each([
    "example.com/path/https://other.org/page",
    "example.com?next=https://other.org/page",
    "example.com#https://other.org/page",
    "www.example.com?next=https://other.org/page",
    "http://example.com?next=https://other.org/page",
    "https://example.com?next=https://other.org/page",
  ])("keeps nested URLs inside the target token %s", (address) => {
    expect(parseBrief(`Rebuild ${address}, only the header.`)).toEqual({
      url: /^https?:\/\//.test(address) ? address : `https://${address}`,
      goal: "Rebuild, only the header.",
    });
  });

  it.each([
    ["wikipedia.com", "https://other.org/page", "https://wikipedia.com"],
    [
      "www.wikipedia.com",
      "https://other.org/page",
      "https://www.wikipedia.com",
    ],
    ["https://other.org/page", "wikipedia.com", "https://other.org/page"],
  ])("selects the first address %s before %s", (first, second, url) => {
    expect(parseBrief(`${first} ${second}`)).toEqual({ url, goal: second });
  });

  it.each([
    "nothttps://example.com",
    "email@https://example.com",
    "ftp://example.com",
    "https://",
    "https:///example.com",
    "https://example.com:invalid",
    "example.com:99999",
  ])("rejects an invalid complete URL token %s", (address) => {
    expect(parseBrief(address)).toBeUndefined();
  });

  it.each([
    ["shop.com.auction;", "shop.com", "https://shop.com"],
    ["tom@www.example.com;", "www.example.com", "https://www.example.com"],
    ["nothttps://example.com;", "https://example.com", "https://example.com"],
  ])("removes the selected occurrence after %s", (rejected, address, url) => {
    expect(parseBrief(`Do not copy ${rejected} copy ${address}`)).toEqual({
      url,
      goal: `Do not copy ${rejected} copy`,
    });
  });

  it("finds no URL in plain text", () => {
    expect(parseBrief("rebuild the daytona landing page")).toBeUndefined();
  });
});

describe("deliver", () => {
  it.each([
    "https://example.com",
    "wikipedia.com",
    "example.com:8443/dashboard?view=mobile#pricing",
    "example.com?next=https://other.org/page",
  ])("creates the run from the first message with %s", async (address) => {
    const client: RunClient = {
      createRun: vi.fn(
        async () => ({ ok: true, value: { runId: "run_1" } }) as const,
      ),
      sendMessage: vi.fn(),
    };
    expect(await deliver(undefined, `copy ${address}`, client)).toEqual({
      runId: "run_1",
    });
    expect(client.createRun).toHaveBeenCalledWith({
      url: address.startsWith("https://") ? address : `https://${address}`,
      goal: "copy",
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    "copy the hero",
    "shop.com.auction",
    "bücher.de",
    "example.com+tag@example.org",
    "www.example.com+tag@example.org",
    "nothttps://example.com",
  ])("asks for the URL instead of creating a run for %s", async (message) => {
    const client: RunClient = { createRun: vi.fn(), sendMessage: vi.fn() };
    expect(await deliver(undefined, message, client)).toEqual({
      needsUrl: true,
    });
    expect(client.createRun).not.toHaveBeenCalled();
  });

  it("sends later messages to the existing run", async () => {
    const client: RunClient = {
      createRun: vi.fn(),
      sendMessage: vi.fn(async () => ({ ok: true, value: undefined }) as const),
    };
    expect(await deliver("run_1", "more", client)).toEqual({ runId: "run_1" });
    expect(client.sendMessage).toHaveBeenCalledWith("run_1", "more");
  });

  it("keeps no run and returns the error when creation fails", async () => {
    const client: RunClient = {
      createRun: vi.fn(async () => notConnected),
      sendMessage: vi.fn(),
    };
    expect(await deliver(undefined, "https://example.com", client)).toEqual({
      error: notConnected,
    });
  });
});

describe("takeIncomingBrief", () => {
  const fakeHistory = (state: unknown) =>
    ({
      state,
      replaceState: vi.fn(function (this: { state: unknown }, next: unknown) {
        this.state = next;
      }),
    }) as unknown as History;

  it("returns the brief once, then clears it", () => {
    const history = fakeHistory({
      brief: "https://www.daytona.io/ copy this site",
    });
    expect(takeIncomingBrief(history)).toBe(
      "https://www.daytona.io/ copy this site",
    );
    expect(takeIncomingBrief(history)).toBeUndefined();
  });

  it("ignores missing or blank briefs", () => {
    expect(takeIncomingBrief(fakeHistory(null))).toBeUndefined();
    expect(takeIncomingBrief(fakeHistory({ brief: "  " }))).toBeUndefined();
  });
});
