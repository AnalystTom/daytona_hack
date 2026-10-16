// Bridge: reads Firstmate's task status files, its backlog and the rebuild's pull requests on
// the in-sandbox Forgejo, and posts what changed to the Worker as EventEnvelope events
// (src/shared/contracts.ts) at POST /api/v1/runs/:id/events. Outbound only: nothing calls in.
// Runs under Node 24 directly (type stripping), so it uses only Node built-ins.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type TaskState =
  | "queued"
  | "building"
  | "in_review"
  | "merged"
  | "failed"
  | "stopped";

export type Observation = {
  key: string;
  type: "task.status" | "backlog.item" | "pull_request";
  taskId?: string;
  state: TaskState;
  message: string;
  artifactRefs: string[];
  timestamp?: string;
};

export type Envelope = {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  runId: string;
  taskId?: string;
  timestamp: string;
  type: string;
  state: string;
  message: string;
  artifactRefs: string[];
};

export type PullRequest = {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  html_url: string;
  head: { ref: string };
};

// Firstmate's worker states, mapped onto the Build view's columns (spec section 6).
// A blocked or paused worker is still Building; the message carries the reason.
const STATUS_STATES: Record<string, TaskState> = {
  working: "building",
  paused: "building",
  blocked: "building",
  "needs-decision": "building",
  resolved: "building",
  done: "in_review",
  failed: "failed",
};

const STATUS_LINE = /^([a-z-]+) \[at=(\d+)\](?: \[key=[^\]]*\])*: (.*)$/;

// One observation per line of a task's append-only state/<task>.status file.
export function statusObservations(taskId: string, text: string) {
  const observations: Observation[] = [];
  text.split("\n").forEach((line, index) => {
    const match = STATUS_LINE.exec(line.trim());
    if (!match) return;
    const [, raw = "", at = "0", detail = ""] = match;
    observations.push({
      key: `status:${taskId}:${index}:${line}`,
      type: "task.status",
      taskId,
      state: STATUS_STATES[raw] ?? "building",
      message: `${raw}: ${detail}`,
      artifactRefs: [],
      timestamp: new Date(Number(at) * 1000).toISOString(),
    });
  });
  return observations;
}

const BACKLOG_ITEM = /^- \[( |x)\] (\S+) - (.*)$/;

// One observation per backlog item and state, so a task that moves column emits once.
export function backlogObservations(text: string) {
  const observations: Observation[] = [];
  let section = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      section = line.slice(3).trim().toLowerCase();
      continue;
    }
    const match = BACKLOG_ITEM.exec(line);
    if (!match) continue;
    const [, , taskId = "", title = ""] = match;
    const state: TaskState =
      section === "done"
        ? /\bmerged\b/.test(title)
          ? "merged"
          : "stopped"
        : section === "in flight" && !title.includes("blocked-by:")
          ? "building"
          : "queued";
    observations.push({
      key: `backlog:${taskId}:${state}`,
      type: "backlog.item",
      taskId,
      state,
      message: title.slice(0, 500),
      artifactRefs: [],
    });
  }
  return observations;
}

// Firstmate names ship branches fm/<task-id>, which ties a pull request to its task.
export function pullRequestObservations(prs: PullRequest[]) {
  return prs.map((pr): Observation => {
    const state: TaskState = pr.merged
      ? "merged"
      : pr.state === "open"
        ? "in_review"
        : "stopped";
    return {
      key: `pr:${pr.number}:${state}`,
      type: "pull_request",
      taskId: pr.head.ref.startsWith("fm/") ? pr.head.ref.slice(3) : undefined,
      state,
      message: `#${pr.number} ${pr.title}`,
      artifactRefs: [pr.html_url],
    };
  });
}

// The event id is stable for an observation, so a retried post is deduplicated by the Worker.
export function toEnvelope(
  observation: Observation,
  context: { runId: string; podId?: string; sequence: number; now: string },
): Envelope {
  const eventId = createHash("sha256")
    .update(`${context.runId}|${context.podId ?? ""}|${observation.key}`)
    .digest("hex")
    .slice(0, 32);
  return {
    schemaVersion: 1,
    eventId,
    sequence: context.sequence,
    runId: context.runId,
    ...(observation.taskId ? { taskId: observation.taskId } : {}),
    timestamp: observation.timestamp ?? context.now,
    type: observation.type,
    state: observation.state,
    message: observation.message,
    // A variant pod reports under its run, tagged with the pod it came from.
    artifactRefs: context.podId
      ? [...observation.artifactRefs, `pod:${context.podId}`]
      : observation.artifactRefs,
  };
}

export type BridgeConfig = {
  stateDir: string;
  fmHome: string;
  forgejoUrl: string;
  forgejoRepo: string;
};

type BridgeState = { sequence: number; sent: string[] };

const readText = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8").trim() : "";

async function listPullRequests(
  config: BridgeConfig,
  doFetch: typeof fetch,
): Promise<PullRequest[]> {
  const token = readText(join(config.stateDir, "forgejo-token"));
  const prs: PullRequest[] = [];
  for (let page = 1; ; page++) {
    const response = await doFetch(
      `${config.forgejoUrl}/api/v1/repos/${config.forgejoRepo}/pulls?state=all&limit=50&page=${page}`,
      { headers: { Authorization: `token ${token}` } },
    );
    if (!response.ok) {
      throw new Error(`Forgejo pull request list failed: ${response.status}`);
    }
    const batch = (await response.json()) as PullRequest[];
    prs.push(...batch);
    if (batch.length < 50) return prs;
  }
}

// One pass: observe, post anything not yet delivered, then record it as sent.
export async function runCycle(
  config: BridgeConfig,
  doFetch: typeof fetch = fetch,
  now = () => new Date().toISOString(),
) {
  const env = (name: string) => readText(join(config.stateDir, "env", name));
  const runId = env("REVERSY_RUN_ID");
  const apiUrl = env("REVERSY_API_URL");
  const token = env("BRIDGE_TOKEN");
  const podId = env("REVERSY_POD_ID") || undefined;
  const missing = [
    ["REVERSY_RUN_ID", runId],
    ["REVERSY_API_URL", apiUrl],
    ["BRIDGE_TOKEN", token],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    return { posted: 0, error: `missing ${missing.join(", ")}` };
  }

  const fmState = join(config.fmHome, "state");
  const observations = [
    ...(existsSync(fmState) ? readdirSync(fmState) : [])
      .filter((file) => file.endsWith(".status"))
      .sort()
      .flatMap((file) =>
        statusObservations(
          file.slice(0, -".status".length),
          readText(join(fmState, file)),
        ),
      ),
    ...backlogObservations(readText(join(config.fmHome, "data", "backlog.md"))),
  ];
  let forgejoError: string | undefined;
  try {
    observations.push(
      ...pullRequestObservations(await listPullRequests(config, doFetch)),
    );
  } catch (error) {
    forgejoError = String(error);
  }

  const statePath = join(config.stateDir, "bridge-state.json");
  const state: BridgeState = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { sequence: 0, sent: [] };
  const sent = new Set(state.sent);
  const timestamp = now();
  let sequence = state.sequence;
  const pending = observations
    .map((observation) =>
      toEnvelope(observation, { runId, podId, sequence: 0, now: timestamp }),
    )
    .filter((envelope) => !sent.has(envelope.eventId))
    .map((envelope) => ({ ...envelope, sequence: ++sequence }));

  let posted = 0;
  for (let start = 0; start < pending.length; start += 500) {
    const batch = pending.slice(start, start + 500);
    const response = await doFetch(
      `${apiUrl}/api/v1/runs/${encodeURIComponent(runId)}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
      },
    );
    if (!response.ok) {
      return {
        posted,
        error: `event post failed: ${response.status} ${(await response.text()).slice(0, 200)}`,
      };
    }
    for (const envelope of batch) sent.add(envelope.eventId);
    posted += batch.length;
    const next: BridgeState = {
      sequence: batch.at(-1)?.sequence ?? state.sequence,
      sent: [...sent],
    };
    mkdirSync(config.stateDir, { recursive: true });
    writeFileSync(`${statePath}.tmp`, JSON.stringify(next));
    renameSync(`${statePath}.tmp`, statePath);
  }
  return { posted, error: forgejoError };
}

async function main() {
  const home = homedir();
  const config: BridgeConfig = {
    stateDir: join(home, ".reversy"),
    fmHome: join(home, "firstmate"),
    forgejoUrl: "http://localhost:3000",
    forgejoRepo: "reversy/rebuild",
  };
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { posted, error } = await runCycle(config);
      if (posted) console.log(`${new Date().toISOString()} posted ${posted}`);
      if (error) console.error(`${new Date().toISOString()} ${error}`);
    } catch (error) {
      console.error(`${new Date().toISOString()} cycle failed: ${error}`);
    } finally {
      running = false;
    }
  };
  await tick();
  setInterval(tick, 5000);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
