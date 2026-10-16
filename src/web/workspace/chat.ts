import { createRun, type RunCallError, sendMessage } from "./runClient";

export type ChatEntry =
  | {
      kind: "user";
      id: string;
      text: string;
      delivery: "sending" | "sent" | "failed";
    }
  | { kind: "agent"; id: string; text: string }
  | {
      kind: "notice";
      id: string;
      error: RunCallError["error"] | "run_error";
      detail: string;
    }
  | { kind: "reconnecting"; id: string }
  | { kind: "sign_in"; id: string; page: string; signInUrl: string };

export type RunClient = {
  createRun: typeof createRun;
  sendMessage: typeof sendMessage;
};

export const askForUrl =
  "Which website should I rebuild? Send its address, like https://www.daytona.io/.";

// A bare host like wikipedia.com/wiki: dotted labels ending in a common or two-letter TLD, not part of an email.
// shortcut: fixed TLD list, so rarer gTLDs need https:// — widen the list if users hit it.
const bareHost =
  /(?<![@\w.-])(?:[a-z0-9-]+\.)+(?!(?:js|ts|py|md|rs|sh|go)\b)(?:com|org|net|io|dev|app|ai|co|edu|gov|info|xyz|site|tech|cloud|[a-z]{2})(?![\w@-])(?:\/[^\s<>"]*)?/i;

// Splits a brief into the target URL and the goal around it; undefined when there is no URL.
export function parseBrief(
  text: string,
): { url: string; goal: string } | undefined {
  const found =
    text.match(/(?:https?:\/\/|\bwww\.)[^\s<>"]+/i) ?? text.match(bareHost);
  if (!found) return undefined;
  const raw = found[0].replace(/[.,;:!?)\]]+$/, "");
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const goal = text
    .replace(raw, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:!?])/g, "$1")
    .trim();
  return { url, goal: goal || "Rebuild this website." };
}

// The first message with a URL creates the run (it is the brief); later ones go to that run.
// Until a run exists, earlier messages without a URL are passed in `brief` and sent with it.
export async function deliver(
  runId: string | undefined,
  text: string,
  client: RunClient = { createRun, sendMessage },
): Promise<{ runId?: string; needsUrl?: true; error?: RunCallError }> {
  if (runId === undefined) {
    const brief = parseBrief(text);
    if (!brief) return { needsUrl: true };
    const created = await client.createRun(brief);
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
