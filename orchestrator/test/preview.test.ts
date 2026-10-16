import { expect, it } from "vitest";
import { handleOrchestrator } from "../../src/worker/orchestrator/front";
import { fetchPreviewLink, signIn } from "../../src/web/workspace/runClient";

it("obtains preview links only after signing in through the session API", async () => {
  const forwarded: string[] = [];
  const url = "https://3000-signed.proxy.daytona.works/";
  const env = {
    OPERATOR_TOKEN: "operator-secret",
    ORCHESTRATOR: {
      async fetch(input: string) {
        forwarded.push(input);
        return Response.json({ url });
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
  expect(await fetchPreviewLink("r1", fetchImpl)).toMatchObject({
    ok: false,
    error: "operator_token",
  });
  expect(forwarded).toEqual([]);
  expect(await signIn("operator-secret", fetchImpl)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await fetchPreviewLink("r1", fetchImpl)).toEqual({
    ok: true,
    value: url,
  });
  expect(forwarded).toEqual(["https://orchestrator/runs/r1/preview"]);
});
