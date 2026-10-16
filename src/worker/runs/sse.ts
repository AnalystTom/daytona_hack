import type { RunStore } from "../store/types";

export interface StreamOptions {
  pollMs: number;
  heartbeatMs: number;
  // The stream closes after this long; EventSource reconnects with Last-Event-ID.
  maxMs: number;
}

export const defaultStreamOptions: StreamOptions = {
  pollMs: 1000,
  heartbeatMs: 15000,
  maxMs: 10 * 60 * 1000,
};

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Server-sent events for a run, read from the store, so a client only ever sees persisted events.
// shortcut: each open stream polls the store; move to a Durable Object fan-out if polling load matters.
export function eventStream(
  store: RunStore,
  runId: string,
  afterSequence: number,
  options: StreamOptions,
): ReadableStream<Uint8Array> {
  let cursor = afterSequence;
  let cancelled = false;
  const deadline = Date.now() + options.maxMs;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("retry: 3000\n\n"));
    },
    async pull(controller) {
      const idleSince = Date.now();
      while (!cancelled) {
        const events = await store.listEvents(runId, cursor, 100);
        const last = events.at(-1);
        if (last) {
          cursor = last.sequence;
          const frames = events.map(
            (event) =>
              `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
          );
          controller.enqueue(encoder.encode(frames.join("")));
          return;
        }
        if (Date.now() >= deadline) {
          controller.close();
          return;
        }
        if (Date.now() - idleSince >= options.heartbeatMs) {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
          return;
        }
        await sleep(options.pollMs);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}
