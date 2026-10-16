// One Arize trace per run, sent as OTLP/HTTP JSON (Workers have no gRPC).
// The trace id is the run id, so every span from any alarm tick lands in the same trace.
import type { Env } from "./types";

type Kind = "CHAIN" | "LLM" | "TOOL" | "AGENT" | "EVALUATOR";
type Attr = string | number | boolean;

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

export class RunTracer {
  readonly traceId: string;
  readonly rootSpanId: string;
  private stack: string[] = [];

  constructor(private env: Env, private ctx: { waitUntil(p: Promise<unknown>): void }, runId: string) {
    this.traceId = runId.replace(/-/g, "").slice(0, 32).padEnd(32, "0");
    this.rootSpanId = this.traceId.slice(0, 16);
  }

  private get enabled() {
    return Boolean(this.env.ARIZE_API_KEY && this.env.ARIZE_SPACE_ID);
  }

  /** Root span for the run; call once at creation. */
  root(input: string) {
    const t = Date.now();
    this.send("reversy.run", "AGENT", this.rootSpanId, undefined, t, t + 1, { "input.value": input }, true);
  }

  async span<T>(name: string, kind: Kind, attrs: Record<string, Attr>, fn: (set: (a: Record<string, Attr>) => void) => Promise<T>): Promise<T> {
    const spanId = hex(8);
    const parent = this.stack.at(-1) || this.rootSpanId;
    const extra: Record<string, Attr> = { ...attrs };
    const start = Date.now();
    this.stack.push(spanId);
    try {
      const out = await fn((a) => Object.assign(extra, a));
      this.send(name, kind, spanId, parent, start, Date.now(), extra, true);
      return out;
    } catch (e: any) {
      extra["exception.message"] = String(e?.message || e).slice(0, 2000);
      this.send(name, kind, spanId, parent, start, Date.now(), extra, false);
      throw e;
    } finally {
      this.stack.pop();
    }
  }

  private send(name: string, kind: Kind, spanId: string, parent: string | undefined, start: number, end: number, attrs: Record<string, Attr>, ok: boolean) {
    if (!this.enabled) return;
    const attributes = Object.entries({ "openinference.span.kind": kind, ...attrs }).map(([key, v]) => ({
      key,
      value: typeof v === "number" ? (Number.isInteger(v) ? { intValue: v } : { doubleValue: v }) : typeof v === "boolean" ? { boolValue: v } : { stringValue: String(v).slice(0, 30000) },
    }));
    const body = {
      resourceSpans: [{
        resource: { attributes: [
          { key: "model_id", value: { stringValue: "reversy-orchestrator" } },
          { key: "openinference.project.name", value: { stringValue: "reversy-orchestrator" } },
        ] },
        scopeSpans: [{
          scope: { name: "reversy" },
          spans: [{
            traceId: this.traceId, spanId, parentSpanId: parent, name, kind: 1,
            startTimeUnixNano: `${start}000000`, endTimeUnixNano: `${end}000000`,
            attributes, status: { code: ok ? 1 : 2 },
          }],
        }],
      }],
    };
    this.ctx.waitUntil(
      fetch("https://otlp.arize.com/v1/traces", {
        method: "POST",
        headers: { "Content-Type": "application/json", space_id: this.env.ARIZE_SPACE_ID!, api_key: this.env.ARIZE_API_KEY! },
        body: JSON.stringify(body),
      }).catch(() => {}),
    );
  }
}
