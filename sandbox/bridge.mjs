// Bridge (docs/orchestrator/spec.md §6): runs inside the sandbox, outbound only.
// Tails Firstmate's fleet ledger and posts each record to the run API as an EventEnvelope
// (src/shared/contracts.ts) at POST {API_URL}/api/v1/runs/{RUN_ID}/events with the BRIDGE_TOKEN.
// Events that fail to send stay queued in bridge-outbox.jsonl and are retried.
//
// Env: RUN_ID, API_URL, BRIDGE_TOKEN (optional until the API is live), FM_HOME (default ~/firstmate)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const FM = process.env.FM_HOME || `${process.env.HOME}/firstmate`;
const LEDGER = `${FM}/state/fleet-ledger.jsonl`;
const STATE = `${FM}/state/bridge-cursor.json`;
const OUTBOX = `${FM}/state/bridge-outbox.jsonl`;
const { RUN_ID = "local", API_URL, BRIDGE_TOKEN } = process.env;

// Kanban columns from the spec: Queued, Building, In review, Merged (+ failed/stopped)
function toEnvelope(rec, seq) {
  const text = (rec.text || "").trim();
  let state = "building";
  let message = "";
  const artifactRefs = [];
  switch (rec.event) {
    case "task.dispatched":
      message = `Dispatched ${rec.kind} task to ${rec.harness}${rec.model ? ` (${rec.model})` : ""}`;
      break;
    case "task.status":
      state = { failed: "failed", blocked: "failed", paused: "stopped", "needs-decision": "building" }[rec.state] || "building";
      message = text || rec.state || "status";
      break;
    case "task.pr_ready":
      state = "in_review";
      message = `Pull request ready for review: ${rec.pr}`;
      artifactRefs.push(rec.pr);
      break;
    case "task.merged":
      state = "merged";
      message = `Merged via ${rec.via}${rec.pr ? `: ${rec.pr}` : ""}`;
      if (rec.pr) artifactRefs.push(rec.pr);
      break;
    case "task.cleaned_up":
      state = "merged";
      message = "Worker and worktree cleaned up";
      break;
    default:
      message = rec.event;
  }
  return {
    schemaVersion: 1,
    eventId: createHash("sha256").update(`${RUN_ID}:${seq}:${JSON.stringify(rec)}`).digest("hex").slice(0, 32),
    sequence: seq,
    runId: RUN_ID,
    taskId: rec.task,
    timestamp: new Date(rec.ts * 1000).toISOString(),
    type: rec.event,
    state,
    message,
    artifactRefs,
  };
}

async function flush() {
  if (!API_URL || !BRIDGE_TOKEN || !existsSync(OUTBOX)) return;
  const lines = readFileSync(OUTBOX, "utf8").split("\n").filter(Boolean);
  if (!lines.length) return;
  const batch = lines.slice(0, 500).map((l) => JSON.parse(l));
  try {
    const res = await fetch(`${API_URL.replace(/\/$/, "")}/api/v1/runs/${RUN_ID}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${BRIDGE_TOKEN}` },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      console.error(`[bridge] POST events ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return;
    }
    writeFileSync(OUTBOX, lines.slice(batch.length).map((l) => `${l}\n`).join(""));
    console.log(`[bridge] sent ${batch.length} event(s)`);
  } catch (e) {
    console.error(`[bridge] send failed: ${e.message}`);
  }
}

function poll() {
  let cursor = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")).lines : 0;
  if (existsSync(LEDGER)) {
    const lines = readFileSync(LEDGER, "utf8").split("\n").filter(Boolean);
    for (let i = cursor; i < lines.length; i++) {
      try {
        const env = toEnvelope(JSON.parse(lines[i]), i);
        appendFileSync(OUTBOX, `${JSON.stringify(env)}\n`);
        console.log(`[bridge] ${env.taskId} ${env.type} -> ${env.state}: ${env.message.slice(0, 100)}`);
      } catch {} // a torn last line is re-read next poll
      cursor = i + 1;
    }
    writeFileSync(STATE, JSON.stringify({ lines: cursor }));
  }
}

console.log(`[bridge] run ${RUN_ID} -> ${API_URL || "(no API_URL yet: queueing to outbox)"}`);
for (;;) {
  poll();
  await flush();
  await new Promise((r) => setTimeout(r, 3000));
}
