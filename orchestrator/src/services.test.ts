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
