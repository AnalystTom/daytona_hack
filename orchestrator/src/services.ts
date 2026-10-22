import { abortable } from "../../src/shared/cancellation";
// OpenAI (chat completions for structured outputs; Responses for web search), SurrealDB Agent Memory, page HTML — all over plain fetch.
import { z } from "zod";
import {
  OPENAI_URL,
  parseJsonReply,
  withJsonSchema,
} from "../../src/shared/openai";
import type { RunTracer } from "./tracing";
import { type Env, USER_AGENT } from "./types";

// Set by the Run that owns this isolate's current work, so every model call lands in its trace.
export const tracing: { current?: RunTracer } = {};

export async function llmJson<T>(
  env: Env,
  opts: {
    instructions: string;
    input: string;
    schema: object;
    name: string;
    beforeCall?: () => Promise<void>;
    effort?: string;
    webSearch?: number;
    onSearchCalls?: (calls: number) => void;
    signal?: AbortSignal;
    model?: string;
  },
): Promise<T> {
  const model = opts.model || env.ORCHESTRATOR_MODEL;
  const call = (set?: (a: Record<string, string | number>) => void) =>
    llmCall<T>(env, opts, model, set);
  return tracing.current
    ? tracing.current.span(
        `llm.${opts.name}`,
        "LLM",
        {
          "llm.model_name": model,
          "input.value": opts.input.slice(0, 20000),
          "llm.system": opts.instructions.slice(0, 4000),
        },
        call,
      )
    : call();
}

async function llmCall<T>(
  env: Env,
  opts: {
    instructions: string;
    input: string;
    schema: object;
    name: string;
    beforeCall?: () => Promise<void>;
    effort?: string;
    webSearch?: number;
    onSearchCalls?: (calls: number) => void;
    signal?: AbortSignal;
  },
  model: string,
  set?: (a: Record<string, string | number>) => void,
): Promise<T> {
  await opts.beforeCall?.();
  opts.signal?.throwIfAborted();
  const format = {
    name: opts.name,
    schema: opts.schema,
    strict: true,
  };
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const res = await fetch(
    `${OPENAI_URL}/${opts.webSearch ? "responses" : "chat/completions"}`,
    {
      signal: opts.signal,
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        opts.webSearch
          ? {
              model,
              reasoning: { effort: opts.effort || "high" },
              instructions: opts.instructions,
              input: opts.input,
              tools: [{ type: "web_search", search_context_size: "low" }],
              max_tool_calls: opts.webSearch,
              // Parallel calls in one turn can overshoot max_tool_calls.
              parallel_tool_calls: false,
              max_output_tokens: 16000,
              text: { format: { type: "json_schema", ...format } },
            }
          : {
              model,
              reasoning_effort: opts.effort || "high",
              messages: [
                {
                  role: "system",
                  content: withJsonSchema(opts.instructions, opts.schema),
                },
                { role: "user", content: opts.input },
              ],
              response_format: { type: "json_schema", json_schema: format },
            },
      ),
    },
  );
  const body = (await res.json()) as {
    output_text?: string;
    output?: {
      type: string;
      content?: { type: string; text?: string }[];
    }[];
    choices?: { message?: { content?: string | null } }[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
    };
  };
  opts.signal?.throwIfAborted();
  if (!res.ok)
    throw new Error(
      `openai ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
    );
  if (opts.webSearch) {
    const calls =
      body.output?.filter(
        (item: { type: string }) => item.type === "web_search_call",
      ).length ?? 0;
    if (!calls) throw new Error("Online source search did not run");
    opts.onSearchCalls?.(calls);
  }
  const text = opts.webSearch
    ? (body.output_text ??
      body.output
        ?.flatMap((o) => o.content || [])
        .find((c) => c.type === "output_text")?.text)
    : body.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error(`openai returned no content`);
  set?.({
    "output.value": text,
    "llm.token_count.prompt":
      body.usage?.input_tokens ?? body.usage?.prompt_tokens ?? 0,
    "llm.token_count.completion":
      body.usage?.output_tokens ?? body.usage?.completion_tokens ?? 0,
  });
  let value: unknown;
  try {
    value = parseJsonReply(text);
  } catch {
    throw new Error(`openai returned invalid JSON: ${text.slice(0, 200)}`);
  }
  const parsed = z
    .fromJSONSchema(opts.schema as z.core.JSONSchema.JSONSchema)
    .safeParse(value);
  if (!parsed.success)
    throw new Error(
      `openai returned output that does not match ${opts.name} schema: ${parsed.error.message}`,
    );
  return parsed.data as T;
}

// --- SurrealDB Agent Memory: observations and decisions with their sources ---
export async function remember(
  env: Env,
  scope: string,
  text: string,
  observedAt?: string,
  beforeWork?: () => Promise<void>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!env.SPECTRON_URL) return;
  const base = `${env.SPECTRON_URL.replace(/\/$/, "")}/api/v1/${env.SPECTRON_CONTEXT_ID}`;
  const headers = {
    Authorization: `Bearer ${env.SPECTRON_API_KEY}`,
    "Content-Type": "application/json",
  };
  const parts = scope.split("/");
  for (let i = 2; i <= parts.length; i++) {
    signal?.throwIfAborted();
    await beforeWork?.();
    signal?.throwIfAborted();
    await abortable(
      fetch(`${base}/scopes`, {
        signal,
        method: "POST",
        headers,
        body: JSON.stringify({ path: parts.slice(0, i).join("/") }),
      }),
      signal,
    );
  }
  signal?.throwIfAborted();
  await beforeWork?.();
  signal?.throwIfAborted();
  const res = await abortable(
    fetch(`${base}/facts`, {
      signal,
      method: "POST",
      headers,
      body: JSON.stringify({
        text,
        infer: "full",
        scopes: [[scope]],
        observed_at: observedAt || new Date().toISOString(),
      }),
    }),
    signal,
  );
  signal?.throwIfAborted();
  if (!res.ok)
    console.log(
      "memory write failed",
      res.status,
      (await res.text()).slice(0, 200),
    );
}

export async function recall(
  env: Env,
  scope: string,
  query: string,
  beforeWork?: () => Promise<void>,
): Promise<string> {
  if (!env.SPECTRON_URL) return "";
  const base = `${env.SPECTRON_URL.replace(/\/$/, "")}/api/v1/${env.SPECTRON_CONTEXT_ID}`;
  await beforeWork?.();
  const res = await fetch(`${base}/context`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SPECTRON_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, k: 10, lens: [[scope]] }),
  });
  return res.ok
    ? ((await res.json()) as { context?: string }).context || ""
    : "";
}

// --- Page HTML for route discovery (Anchor when set, else a plain fetch) ---
export async function pageHtml(
  env: Env,
  url: string,
  beforeWork?: () => Promise<void>,
): Promise<{ html: string; tool: "anchor" | "fetch" }> {
  if (env.ANCHORBROWSER_API_KEY) {
    await beforeWork?.();
    const res = await fetch(
      "https://api.anchorbrowser.io/v1/tools/fetch/webpage",
      {
        method: "POST",
        headers: {
          "anchor-api-key": env.ANCHORBROWSER_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      },
    );
    if (res.ok) return { html: await res.text(), tool: "anchor" };
  }
  await beforeWork?.();
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  return { html: await res.text(), tool: "fetch" };
}

export async function sha256(content: string | ArrayBuffer) {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
