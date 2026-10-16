# Orchestrator API (for the Cloudflare backend)

The orchestrator is a Cloudflare Worker (`orchestrator/`) with one Durable Object per run.
It owns the phases from [`spec.md`](spec.md): brief (chat), inspect, plan, build and review.
Code is written only inside Daytona sandboxes, by Codex workers. Everything else runs on Cloudflare.

Call it through a service binding (`env.ORCHESTRATOR.fetch(...)`); it has no public address.

## Routes

| Method and path | Body | Does |
|---|---|---|
| `POST /runs` | `{url, goal}` | Creates a run, takes a first look (HTML, routes, screenshot if Anchor is set), returns state with the first chat reply |
| `GET /runs/:id` | | Full state: `{id, phase, spec, chat, evidence, tasks, sandboxId, previewUrl, error}` |
| `GET /runs/:id/preview` | | `{url}`: a 30-minute signed link to the private sandbox preview; 404 before the build serves one or after the run stops |
| `GET /runs/:id/events?since=N` | | Events after `seq` N, oldest first |
| `GET /runs/:id/evidence/:evId` | | Screenshot PNG for an evidence card |
| `POST /runs/:id/messages` | `{text}` | User chat message. The orchestrator replies and updates the spec. If the user clearly approves, it starts inspection |
| `POST /runs/:id/approve` | | Approve the spec explicitly. Inspection and planning run in the background; watch events |
| `POST /runs/:id/build` | | Start build. Needs phase `planned`, otherwise 500 with "No build started: tasks appear after the spec is approved." |
| `POST /runs/:id/stop` | | Stop build: kills workers, marks open tasks `stopped` |
| `POST /runs/:id/override` | `{taskId, verdict: "approve"\|"reject", reason}` | User overrides a review verdict |
| `POST /runs/:id/variants` | | Needs phase `done`. Builds three landing-page variants from a snapshot of the merged rebuild (phase `variants`, back to `done` when they finish) |
| `POST /runs/:id/promote` | `{variantId}` | Needs phase `done` and a `ready` variant. Returns to `brief` for follow-up instructions; the next approved plan builds in the promoted sandbox. One promotion per run |
| `POST /gateway/capture` | `{url, kind: "screenshot"\|"html", width?, height?}` | Sandbox network gateway (Bearer `GATEWAY_TOKEN`): screenshot through Anchor or page HTML |
| `POST /gateway/remember`, `/gateway/recall` | `{runId, text, observedAt?}` / `{runId, query}` | Sandbox gateway to SurrealDB Agent Memory (Bearer `GATEWAY_TOKEN`) |
| `POST /sandboxes/:id/captain`, `GET /sandboxes/:id/screen` | `{text}` | Types a captain message into the first mate's tmux pane, or reads that pane (Bearer `OPERATOR_TOKEN`) |

If `EVENTS_WEBHOOK_URL` is set, every event is also POSTed there as `{runId, seq, ts, type, data}`.

## Phases

`brief` → `inspecting` → `planning` → `planned` → `building` → `done` (→ `variants` → `done`), or `stopped` / `failed`.

Each run is limited to 2 hours from its creation. At the limit the orchestrator stops the workers and every sandbox of the run,
emits `phase {phase: "stopped", reason: "time_limit"}`, and refuses further actions. Sandboxes also auto-stop after 60 idle minutes.
Failed sandbox shutdowns stay pending and are retried by alarms until Daytona confirms they stopped.

## Events

`{seq, ts, type, data}`:

| type | data | UI |
|---|---|---|
| `chat` | `{role, text, ts}` | Chat panel |
| `spec` | Spec (`pages[]`, `flows[]` with `confirmed`, `openQuestions[]`, `approved`, `revision`) | Draft spec card. Unconfirmed items show "Not confirmed yet" |
| `evidence` | Evidence (`id, page, kind, tool, status, capturedAt, hash, limits, summary, url?`) | Screenshot / evidence cards. `status` is `observed`, `inferred` or `not_observed` |
| `plan` | `{tasks: Task[]}` | Kanban, all in Queued |
| `task` | Task | Move card: `queued`→Queued, `building`→Building, `in_review`→In review, `merged`→Merged; `failed`/`stopped` stay with `failure` and `nextAction` |
| `review` | `{taskId, verdict, reason, findings, diffStat}` | Review card on the task |
| `preview` | `{sandboxId?, mergedTask?, promoted?}` | The integration branch's preview changed (Daytona port 3000, private); fetch `GET /runs/:id/preview` for a signed link |
| `phase` | `{phase, ...}` | Header state; enable Start build on `planned` |
| `verification` | `{target, taskId?, pass, summary, findings, model}` | GPT verifier verdict on the plan, a merged task, or the final rebuild |
| `variant` | `{id, title, change, explanation, pod: "fork"\|"copy", previewUrl, snapshot, status}` | Variant card on the Preview tab; `status` is `building`, `ready`, `failed` or `promoted` |
| `error` | `{message}` | Inline error state |

## How a build runs

- One Daytona sandbox per run (`daytona-medium`). The rebuild repo is at `/home/daytona/app` on `main`.
- Evidence is copied to `/home/daytona/evidence` and made read-only before any worker starts.
- Each task gets its own git worktree and branch `task/<id>`. A Codex worker (`gpt-6.1-sol`, high reasoning) runs there.
  Codex's own sandbox cannot start inside the Daytona container, so the Daytona sandbox is the isolation boundary.
- A task is dispatched when all its dependencies are merged, up to `MAX_WORKERS` at once. The Durable Object alarm polls every 10 s.
- When a worker exits, the orchestrator commits its worktree, and GPT reviews the diff against the task, its acceptance criteria and the files it owns.
  Approve → `git merge --no-ff` into `main`, and the preview (`npx serve` on port 3000) shows it. Reject → one revision with the review findings, then `failed` with the reason.
- If the verifier fails a merged task, the orchestrator opens one fix task `<id>-fix` on top of it and keeps building; nothing is rolled back.
- Observations, plans and review verdicts are written to SurrealDB Agent Memory under `org/reversy/run/<id>`.
- Events remain in the run's Durable Object event log. External SurrealDB run records (run, events, tasks, steering, approvals)
  use one best-effort call per event through the `RECORDS` binding to the `reversy` Worker's `Records` entrypoint, which holds the credentials and has no HTTP route.
  Failed writes can leave missing events or partial projections, including steering, approvals and run updates; there is no durable replay or projection repair.
  Each failed call adds a local `error` event naming the affected sequence. These notices are not sent back to `RECORDS`.

## Variants

Three landing-page alternatives, each one task built and reviewed like any other, in a pod started from the merged rebuild's commit.
A pod is a Daytona fork of the run sandbox where the account allows it, otherwise a copy of the repo inside the run sandbox
(`/home/daytona/variants/<id>`, previewed on port 3001-3003), labelled `copy`. Each pod runs at most 2 workers at once.
Promoting a copy merges it into `main`; promoting a fork makes it the run's sandbox and stops the other pods.
A variant becomes `ready` only when all its tasks are merged and verification passes, including any required fix task.
A failed review, failed fix verification, or unavailable verifier prevents promotion; existing `ready` status alone is insufficient.
Variant previews also stay private: their event URLs are signed for two hours, and the run deadline still shuts the sandboxes down.
Promotion returns to the brief so the user can describe the next changes and approve a follow-up plan.
Starting that plan reuses the promoted sandbox and its merged files instead of creating a new sandbox.

## Verifier

The verifier is a GPT model: it runs on `VERIFIER_MODEL` (OpenAI, like every model in the demo) from Cloudflare,
outside the sandbox, with its own instructions. Its events carry the model name. It checks the plan before build, each merged task (against the live preview)
and the final rebuild, and emits `verification` events `{target: "plan"|"task"|"final", taskId?, pass, summary, findings[]}`.
A failed verdict is also posted to chat as steering. Tasks retain the boolean result in `verification`; absence means no completed check.
A task verifier-request error marks the task `failed` with its reason and a next action to approve its review to retry verification; the merged code stays in place.
No fix task is generated from an unavailable verifier. A plan-request failure leaves the run `failed`; final-check request failures keep the build active for its next alarm instead of announcing completion.

## Deployed

No public address: `workers_dev` and `preview_urls` are off. The `reversy` Worker reaches it through its `ORCHESTRATOR` service binding,
the workspace through `/api/v1/runs/*` and operators through `/api/v1/orchestrator/*`, both with `Authorization: Bearer <OPERATOR_TOKEN>`
(reads included; `sandboxId` is dropped from every `/api/v1/runs` JSON reply, state and events included).
`/api/v1/runs/*` also accepts the signed session cookie that `POST /api/v1/session` sets on this site (see the README's Run API).
`orchestrator/scripts/demo-run.sh` drives one full run that way (set `REVERSY_URL` and `OPERATOR_TOKEN`).

## Not built yet

- Anchor screenshots and recordings: the code calls `POST /v1/tools/screenshot` once `ANCHORBROWSER_API_KEY` is set. Until then, screenshot evidence is `not_observed` and HTML comes from a plain fetch.
- Secure sign-in.
- Deploy live: the Preview tab shows a disabled Deploy live control until there is a deploy target.

## Run locally

```
cd orchestrator && npm install
# .dev.vars: OPENAI_API_KEY, DAYTONA_API_KEY, SPECTRON_URL, SPECTRON_CONTEXT_ID, SPECTRON_API_KEY, ANCHORBROWSER_API_KEY
npx wrangler dev
```
