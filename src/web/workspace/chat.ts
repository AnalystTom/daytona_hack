import { createRun, type RunCallError, sendMessage } from "./runClient";

export type ChatEntry =
  | {
      kind: "user";
      id: string;
      text: string;
      delivery: "sending" | "sent" | "failed";
    }
  | { kind: "agent"; id: string; text: string }
  | { kind: "notice"; id: string; error: RunCallError["error"]; detail: string }
  | { kind: "reconnecting"; id: string }
  | { kind: "sign_in"; id: string; page: string; signInUrl: string };

export type RunClient = {
  createRun: typeof createRun;
  sendMessage: typeof sendMessage;
};

// The first message creates the run (it is the brief); later ones go to that run.
// shortcut: until a run exists, any new message is sent as the brief; queue undelivered messages if that misorders briefs.
export async function deliver(
  runId: string | undefined,
  text: string,
  client: RunClient = { createRun, sendMessage },
): Promise<{ runId?: string; error?: RunCallError }> {
  if (runId === undefined) {
    const created = await client.createRun(text);
    return created.ok ? { runId: created.value.runId } : { error: created };
  }
  const sent = await client.sendMessage(runId, text);
  return sent.ok ? { runId } : { runId, error: sent };
}

// A brief handed over from /start arrives as history state, so a shared link never re-sends it.
export function takeIncomingBrief(history: History): string | undefined {
  const brief: unknown = history.state?.brief;
  if (typeof brief !== "string" || brief.trim() === "") return undefined;
  history.replaceState({ ...history.state, brief: undefined }, "");
  return brief;
}
