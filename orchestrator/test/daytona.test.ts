import { afterEach, describe, expect, it, vi } from "vitest";
import { Daytona } from "../src/daytona";
import type { Env } from "../src/types";

const client = () =>
  new Daytona({ DAYTONA_API_URL: "https://daytona.test" } as Env);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Daytona shutdown", () => {
  it("waits for stopped after the stop request is accepted", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const fetcher = vi.fn(async (_input: string, init: RequestInit = {}) =>
      init.method === "POST"
        ? Response.json({})
        : Response.json({ state: ["started", "stopping", "stopped"][reads++] }),
    );
    vi.stubGlobal("fetch", fetcher);
    let complete = false;
    const stopping = client()
      .stop("sb1")
      .then(() => {
        complete = true;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toBe(false);
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    await stopping;
    expect(complete).toBe(true);
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it.each(["stopped", "stopping"])(
    "resumes shutdown from %s without another stop request",
    async (state) => {
      let reads = 0;
      const fetcher = vi.fn(async (_input: string, _init: RequestInit = {}) =>
        Response.json({ state: reads++ ? "stopped" : state }),
      );
      vi.stubGlobal("fetch", fetcher);
      await client().stop("sb1");
      expect(
        fetcher.mock.calls.some(([, init]) => init?.method === "POST"),
      ).toBe(false);
      expect(reads).toBe(state === "stopped" ? 1 : 2);
    },
  );

  it.each(["error", "build_failed"])(
    "rejects a terminal shutdown failure: %s",
    async (state) => {
      let reads = 0;
      vi.stubGlobal("fetch", async (_input: string, init: RequestInit = {}) =>
        Response.json(
          init.method === "POST" ? {} : { state: reads++ ? state : "started" },
        ),
      );
      await expect(client().stop("sb1")).rejects.toThrow(state);
    },
  );

  it("rejects a shutdown that never completes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => Response.json({ state: "stopping" }));
    const stopping = expect(client().stop("sb1")).rejects.toThrow(
      "did not stop",
    );
    await vi.runAllTimersAsync();
    await stopping;
  });

  it.each(["create", "fork"] as const)(
    "reports allocated ownership before %s startup can fail",
    async (action) => {
      const owned: string[] = [];
      vi.stubGlobal("fetch", async (_input: string, init: RequestInit = {}) => {
        if (init.method === "POST") return Response.json({ id: "sb1" });
        expect(owned).toEqual(["sb1"]);
        return Response.json({ state: "error" });
      });
      const allocated = async (id: string) => {
        owned.push(id);
      };
      await expect(
        action === "create"
          ? client().create({}, undefined, allocated)
          : client().fork("main", allocated),
      ).rejects.toThrow("sandbox sb1 error");
      expect(owned).toEqual(["sb1"]);
    },
  );
});
