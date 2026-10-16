import { z } from "zod";
import { deriveBoard } from "../build/board";
import type { ChatEntry } from "./chat";
import {
  chatEntries,
  OrchestratorEvent,
  type RunView,
  runView,
} from "./orchestrator";
import type { RunCallResult } from "./runClient";

// The public example: a saved copy of one finished run (GET /api/v1/example), replayed read-only.

export const Example = z.object({
  runId: z.string().min(1),
  target: z.string(),
  phase: z.string(),
  finishedAt: z.string(),
  savedAt: z.string(),
  events: z.array(OrchestratorEvent),
});
export type Example = z.infer<typeof Example>;

export async function fetchExample(
  fetchImpl: typeof fetch = fetch,
): Promise<RunCallResult<Example>> {
  let response: Response;
  try {
    response = await fetchImpl("/api/v1/example");
  } catch {
    return {
      ok: false,
      error: "not_connected",
      detail: "Reversy could not be reached.",
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      error: "not_found",
      detail: "No example run has been saved yet.",
    };
  }
  const example = Example.safeParse(
    response.ok ? await response.json().catch(() => undefined) : undefined,
  );
  return example.success
    ? { ok: true, value: example.data }
    : {
        ok: false,
        error: "failed",
        detail: `The example could not be loaded (HTTP ${response.status}).`,
      };
}

export type ExampleView = {
  run: RunView;
  entries: ChatEntry[];
  // How the run's tasks ended, for example "1 merged, 2 failed, 5 never started".
  outcome: string;
};

export function exampleView(example: Example): ExampleView {
  const run = runView(example.runId, example.events);
  // Screenshots come from the saved copy, not from the run.
  const runEvidence = `/api/v1/runs/${example.runId}/evidence/`;
  run.evidence = run.evidence.map((item) => ({
    ...item,
    src: item.src?.replace(
      runEvidence,
      `/api/v1/example/${example.runId}/evidence/`,
    ),
  }));
  const counts = new Map<string, number>();
  for (const task of deriveBoard(run.board).tasks) {
    const state = task.state ?? "queued";
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const outcome = [...counts]
    .map(([state, n]) =>
      state === "queued"
        ? `${n} never started`
        : `${n} ${state.replace("_", " ")}`,
    )
    .join(", ");
  return {
    run,
    entries: chatEntries(example.events, { withUser: true }),
    outcome,
  };
}
