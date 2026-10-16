// OpenAI (structured outputs), SurrealDB Agent Memory, Anchor Browser — all over plain fetch.
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
    effort?: string;
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
    effort?: string;
  },
  model: string,
  set?: (a: Record<string, string | number>) => void,
): Promise<T> {
  const res = await fetch("https://api.openai.com/v1/responses", {
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
  if (!res.ok)
    throw new Error(
      `openai ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
    );
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
) {
  if (!env.SPECTRON_URL) return;
  const base = `${env.SPECTRON_URL.replace(/\/$/, "")}/api/v1/${env.SPECTRON_CONTEXT_ID}`;
  const headers = {
    Authorization: `Bearer ${env.SPECTRON_API_KEY}`,
    "Content-Type": "application/json",
  };
  const parts = scope.split("/");
  for (let i = 2; i <= parts.length; i++) {
    await fetch(`${base}/scopes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: parts.slice(0, i).join("/") }),
    });
  }
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
): Promise<string> {
  if (!env.SPECTRON_URL) return "";
  const base = `${env.SPECTRON_URL.replace(/\/$/, "")}/api/v1/${env.SPECTRON_CONTEXT_ID}`;
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

// --- Anchor Browser (optional until a key exists) ---
export async function anchorScreenshot(
  env: Env,
  url: string,
  width: number,
  height: number,
): Promise<ArrayBuffer | null> {
  if (!env.ANCHORBROWSER_API_KEY) return null;
  const res = await fetch("https://api.anchorbrowser.io/v1/tools/screenshot", {
    method: "POST",
    headers: {
      "anchor-api-key": env.ANCHORBROWSER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      width,
      height,
      capture_full_height: true,
      wait: 1500,
    }),
  });
  return res.ok ? res.arrayBuffer() : null;
}

export async function pageHtml(
  env: Env,
  url: string,
): Promise<{ html: string; tool: "anchor" | "fetch" }> {
  if (env.ANCHORBROWSER_API_KEY) {
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
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh) Reversy-Inspector" },
  });
  return { html: await res.text(), tool: "fetch" };
}

export async function sha256(data: string | ArrayBuffer): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
