import { expect, it, vi } from "vitest";
import orchestrator from "../src/index";
import type { Env } from "../src/types";
import { handleOrchestrator } from "../../src/worker/orchestrator/front";
import { fetchPreviewLink, signIn } from "../../src/web/workspace/runClient";

it("obtains preview links only after signing in through the session API", async () => {
  const forwarded: string[] = [];
  const url = "https://3000-signed.proxy.daytona.works/";
  const previewLink = vi.fn(
    async (_seconds?: number, _variant?: string) => url,
  );
  const runs = { idFromName: (id: string) => id, get: () => ({ previewLink }) };
  const env = {
    OPERATOR_TOKEN: "operator-secret",
    ORCHESTRATOR: {
      async fetch(input: string, init: RequestInit = {}) {
        forwarded.push(input);
        return orchestrator.fetch(new Request(input, init), {
          RUNS: runs,
        } as unknown as Env);
      },
    } as unknown as Fetcher,
  };
  let cookie = "";
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("origin", "https://reversy.test");
    if (cookie) headers.set("cookie", cookie);
    const response = await handleOrchestrator(
      new Request(`https://reversy.test${input}`, { ...init, headers }),
      env,
    );
    if (!response) throw new Error("Unknown route");
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0]!;
    return response;
  }) as typeof fetch;
  expect(await fetchPreviewLink("r1", undefined, fetchImpl)).toMatchObject({
    ok: false,
    error: "operator_token",
  });
  expect(await fetchPreviewLink("r1", "v1", fetchImpl)).toMatchObject({
    ok: false,
    error: "operator_token",
  });
  expect(forwarded).toEqual([]);
  expect(await signIn("operator-secret", fetchImpl)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await fetchPreviewLink("r1", undefined, fetchImpl)).toEqual({
    ok: true,
    value: url,
  });
  expect(await fetchPreviewLink("r1", "v1", fetchImpl)).toEqual({
    ok: true,
    value: url,
  });
  expect(previewLink.mock.calls).toEqual([
    [undefined, undefined],
    [undefined, "v1"],
  ]);
  expect(forwarded).toEqual([
    "https://orchestrator/runs/r1/preview",
    "https://orchestrator/runs/r1/preview?variant=v1",
  ]);
  expect(await fetchPreviewLink("r1", "../bad", fetchImpl)).toMatchObject({
    ok: false,
    error: "failed",
  });
  env.OPERATOR_TOKEN = "rotated";
  expect(await fetchPreviewLink("r1", "v1", fetchImpl)).toMatchObject({
    ok: false,
    error: "operator_token",
  });
  expect(previewLink).toHaveBeenCalledTimes(2);
});
