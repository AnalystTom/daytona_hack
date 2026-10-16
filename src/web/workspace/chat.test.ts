import { describe, expect, it, vi } from "vitest";
import { deliver, type RunClient, takeIncomingBrief } from "./chat";

const notConnected = {
  ok: false,
  error: "not_connected",
  detail: "The run service is not available yet.",
} as const;

describe("deliver", () => {
  it("creates the run from the first message", async () => {
    const client: RunClient = {
      createRun: vi.fn(
        async () => ({ ok: true, value: { runId: "run_1" } }) as const,
      ),
      sendMessage: vi.fn(),
    };
    expect(await deliver(undefined, "brief", client)).toEqual({
      runId: "run_1",
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
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
    expect(await deliver(undefined, "brief", client)).toEqual({
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
