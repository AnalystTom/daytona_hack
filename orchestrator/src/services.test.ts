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

const verdictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pass", "summary", "findings"],
  properties: {
    pass: { type: "boolean" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "evidence", "problem"],
        properties: {
          item: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          problem: { type: "string" },
        },
      },
    },
  },
};

const failedVerdict = {
  pass: false,
  summary: "Failed",
  findings: [{ item: "task", evidence: ["e1"], problem: "Missing behavior" }],
};

const approvalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["userApproved", "scope"],
  properties: {
    userApproved: { type: "boolean" },
    scope: { type: "string", enum: ["frontend", "backend", "both", "report"] },
  },
};

for (const webSearch of [undefined, 1]) {
  const provider = webSearch ? "OpenAI" : "Nicrron";
  const respond = (value: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          webSearch
            ? {
                output: [{ type: "web_search_call" }],
                output_text: JSON.stringify(value),
              }
            : { choices: [{ message: { content: JSON.stringify(value) } }] },
        ),
      ),
    );
  const call = (schema: object = verdictSchema) =>
    llmJson({ NICRRON_API_KEY: "nk", OPENAI_API_KEY: "ok" } as Env, {
      instructions: "i",
      input: "x",
      schema,
      name: "validated_result",
      webSearch,
    });

  it(`${provider} preserves a valid failed verdict and nested evidence`, async () => {
    respond(failedVerdict);
    await expect(call()).resolves.toEqual(failedVerdict);
  });

  it.each([
    ["string pass", { ...failedVerdict, pass: "false" }],
    ["missing field", { pass: false, findings: [] }],
    ["unexpected field", { ...failedVerdict, extra: true }],
    ["null object", null],
    ["wrong summary type", { ...failedVerdict, summary: 1 }],
    ["wrong array type", { ...failedVerdict, findings: {} }],
    ["wrong array item", { ...failedVerdict, findings: ["bad"] }],
    [
      "missing nested field",
      { ...failedVerdict, findings: [{ item: "task" }] },
    ],
    [
      "unexpected nested field",
      {
        ...failedVerdict,
        findings: [{ ...failedVerdict.findings[0], extra: 1 }],
      },
    ],
    [
      "wrong nested evidence item",
      {
        ...failedVerdict,
        findings: [{ ...failedVerdict.findings[0], evidence: [1] }],
      },
    ],
  ])(`${provider} rejects %s`, async (_label, value) => {
    respond(value);
    await expect(call()).rejects.toThrow(
      "does not match validated_result schema",
    );
  });

  it.each([
    { userApproved: "false", scope: "frontend" },
    { userApproved: false, scope: "unknown" },
  ])(
    `${provider} rejects invalid approval $userApproved and scope $scope`,
    async (value) => {
      respond(value);
      await expect(call(approvalSchema)).rejects.toThrow(
        "does not match validated_result schema",
      );
    },
  );

  it(`${provider} preserves a valid unapproved scope`, async () => {
    const value = { userApproved: false, scope: "frontend" };
    respond(value);
    await expect(call(approvalSchema)).resolves.toEqual(value);
  });
}
