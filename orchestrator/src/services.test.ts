import { afterEach, expect, it, vi } from "vitest";
import { llmJson } from "./services";
import type { Env } from "./types";

afterEach(() => vi.unstubAllGlobals());

it("caps web-search tool calls in the request and reports the provider's real count", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      output: Array.from({ length: 6 }, () => ({ type: "web_search_call" })),
      output_text: "{}",
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const onSearchCalls = vi.fn();
  await llmJson({ OPENAI_API_KEY: "k" } as Env, {
    instructions: "i",
    input: "x",
    schema: {},
    name: "n",
    webSearch: 4,
    onSearchCalls,
  });
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.max_tool_calls).toBe(4);
  expect(body.parallel_tool_calls).toBe(false);
  expect(onSearchCalls).toHaveBeenCalledWith(6);
});

it("sends non-search calls to Nicrron chat completions with strict JSON output", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      choices: [{ message: { content: '```json\n{"a":1}\n```' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const out = await llmJson<{ a: number }>(
    { NICRRON_API_KEY: "nk", OPENAI_API_KEY: "ok" } as Env,
    { instructions: "i", input: "x", schema: { type: "object" }, name: "n" },
  );
  expect(out).toEqual({ a: 1 });
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe("https://api.nicrron.ai/v1/chat/completions");
  expect(init.headers.Authorization).toBe("Bearer nk");
  const body = JSON.parse(init.body);
  expect(body.model).toBe("nicrron/auto");
  expect(body.messages[0].content).toContain("i\n\nReply with only one JSON");
  expect(body.messages[1]).toEqual({ role: "user", content: "x" });
  expect(body.response_format.json_schema).toMatchObject({
    name: "n",
    strict: true,
  });
});

it("fails a Nicrron call that returned no content, such as a refusal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        choices: [{ message: { content: null, refusal: "No" } }],
      }),
    ),
  );
  await expect(
    llmJson({ NICRRON_API_KEY: "nk" } as Env, {
      instructions: "i",
      input: "x",
      schema: {},
      name: "n",
    }),
  ).rejects.toThrow("returned no content");
});
