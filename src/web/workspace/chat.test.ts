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

  it("finds no URL in plain text", () => {
    expect(parseBrief("rebuild the daytona landing page")).toBeUndefined();
  });
});

describe("deliver", () => {
  it("creates the run from the first message with a URL", async () => {
    const client: RunClient = {
      createRun: vi.fn(
        async () => ({ ok: true, value: { runId: "run_1" } }) as const,
      ),
      sendMessage: vi.fn(),
    };
    expect(
      await deliver(undefined, "copy https://example.com", client),
    ).toEqual({
      runId: "run_1",
    });
    expect(client.createRun).toHaveBeenCalledWith({
      url: "https://example.com",
      goal: "copy",
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("asks for the URL instead of creating a run without one", async () => {
    const client: RunClient = { createRun: vi.fn(), sendMessage: vi.fn() };
    expect(await deliver(undefined, "copy the hero", client)).toEqual({
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
