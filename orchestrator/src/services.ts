// OpenAI (structured outputs), SurrealDB Agent Memory, page HTML — all over plain fetch.
import type { RunTracer } from "./tracing";
import type { Env } from "./types";

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
  const res = await fetch("https://api.openai.com/v1/responses", {
    signal: opts.signal,
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: opts.effort || "high" },
      instructions: opts.instructions,
      input: opts.input,
      ...(opts.webSearch
        ? {
            tools: [{ type: "web_search", search_context_size: "low" }],
            max_tool_calls: opts.webSearch,
            // Parallel calls in one turn can overshoot max_tool_calls.
            parallel_tool_calls: false,
            max_output_tokens: 16000,
          }
        : {}),
      text: {
        format: {
          type: "json_schema",
          name: opts.name,
          schema: opts.schema,
          strict: true,
        },
      },
    }),
  });
  const body: any = await res.json();
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
  const text =
    body.output_text ??
    body.output
      ?.flatMap((o: any) => o.content || [])
      .find((c: any) => c.type === "output_text")?.text;
  set?.({
    "output.value": text,
    "llm.token_count.prompt": body.usage?.input_tokens || 0,
    "llm.token_count.completion": body.usage?.output_tokens || 0,
  });
  return JSON.parse(text) as T;
}

// --- SurrealDB Agent Memory: observations and decisions with their sources ---
export async function remember(
  env: Env,
  scope: string,
  text: string,
  observedAt?: string,
  beforeWork?: () => Promise<void>,
) {
  if (!env.SPECTRON_URL) return;
  const base = `${env.SPECTRON_URL.replace(/\/$/, "")}/api/v1/${env.SPECTRON_CONTEXT_ID}`;
  const headers = {
    Authorization: `Bearer ${env.SPECTRON_API_KEY}`,
    "Content-Type": "application/json",
  };
  const parts = scope.split("/");
  for (let i = 2; i <= parts.length; i++) {
    await beforeWork?.();
    await fetch(`${base}/scopes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: parts.slice(0, i).join("/") }),
    });
  }
  await beforeWork?.();
  const res = await fetch(`${base}/facts`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text,
      infer: "full",
      scopes: [[scope]],
      observed_at: observedAt || new Date().toISOString(),
    }),
  });
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
  return res.ok ? ((await res.json()) as any).context || "" : "";
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
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh) Reversy-Inspector" },
  });
  return { html: await res.text(), tool: "fetch" };
}

export async function sha256(content: string | ArrayBuffer) {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
