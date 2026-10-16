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
| `GET /runs/:id/events?since=N` | | Events after `seq` N, oldest first |
| `GET /runs/:id/evidence/:evId` | | Screenshot PNG for an evidence card |
| `POST /runs/:id/messages` | `{text}` | User chat message. The orchestrator replies and updates the spec. If the user clearly approves, it starts inspection |
| `POST /runs/:id/approve` | | Approve the spec explicitly. Inspection and planning run in the background; watch events |
| `POST /runs/:id/build` | | Start build. Needs phase `planned`, otherwise 500 with "No build started: tasks appear after the spec is approved." |
| `POST /runs/:id/stop` | | Stop build: kills workers, marks open tasks `stopped` |
| `POST /runs/:id/override` | `{taskId, verdict: "approve"\|"reject", reason}` | User overrides a review verdict |
| `POST /gateway/capture` | `{url, kind: "screenshot"\|"html", width?, height?}` | Sandbox network gateway (Bearer `GATEWAY_TOKEN`): screenshot through Anchor or page HTML |
| `POST /gateway/remember`, `/gateway/recall` | `{runId, text, observedAt?}` / `{runId, query}` | Sandbox gateway to SurrealDB Agent Memory (Bearer `GATEWAY_TOKEN`) |
| `POST /sandboxes/:id/captain`, `GET /sandboxes/:id/screen` | `{text}` | Types a captain message into the first mate's tmux pane, or reads that pane (Bearer `OPERATOR_TOKEN`) |

If `EVENTS_WEBHOOK_URL` is set, every event is also POSTed there as `{runId, seq, ts, type, data}`.

## Phases

`brief` → `inspecting` → `planning` → `planned` → `building` → `done`, or `stopped` / `failed`.

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
| `preview` | `{url, sandboxId?, mergedTask?}` | Live preview of the integration branch (Daytona port 3000, public) |
| `phase` | `{phase, ...}` | Header state; enable Start build on `planned` |
| `verification` | `{target, taskId?, pass, summary, findings}` | Verifier verdict on the plan, a merged task, or the final rebuild |
| `error` | `{message}` | Inline error state |

## How a build runs

- One Daytona sandbox per run (`daytona-medium`). The rebuild repo is at `/home/daytona/app` on `main`.
- Evidence is copied to `/home/daytona/evidence` and made read-only before any worker starts.
- Each task gets its own git worktree and branch `task/<id>`. A Codex worker (`gpt-6.1-sol`, high reasoning) runs there.
  Codex's own sandbox cannot start inside the Daytona container, so the Daytona sandbox is the isolation boundary.
- A task is dispatched when all its dependencies are merged, up to `MAX_WORKERS` at once. The Durable Object alarm polls every 10 s.
- When a worker exits, the orchestrator commits its worktree, and GPT reviews the diff against the task, its acceptance criteria and the files it owns.
  Approve → `git merge --no-ff` into `main`, and the preview (`npx serve` on port 3000) shows it. Reject → one revision with the review findings, then `failed` with the reason.
- Observations, plans and review verdicts are written to SurrealDB Agent Memory under `org/reversy/run/<id>`.

## Verifier

The spec asks for Opus 5.5; we have no Anthropic key, so the verifier runs on `VERIFIER_MODEL` (OpenAI) from Cloudflare,
outside the sandbox, with its own instructions. It checks the plan before build, each merged task (against the live preview)
and the final rebuild, and emits `verification` events `{target: "plan"|"task"|"final", taskId?, pass, summary, findings[]}`.
A failure is also posted to chat as steering.

## Deployed

No public address: `workers_dev` and `preview_urls` are off. The `reversy` Worker reaches it through its `ORCHESTRATOR` service binding,
the workspace through `/api/v1/runs/*` and operators through `/api/v1/orchestrator/*`, both with `Authorization: Bearer <OPERATOR_TOKEN>`
(reads included; `sandboxId` is dropped from run state and events).
`orchestrator/scripts/demo-run.sh` drives one full run that way (set `REVERSY_URL` and `OPERATOR_TOKEN`).

## Not built yet

- Anchor screenshots and recordings: the code calls `POST /v1/tools/screenshot` once `ANCHORBROWSER_API_KEY` is set. Until then, screenshot evidence is `not_observed` and HTML comes from a plain fetch.
- Variant pods (fork), Arize tracing, secure sign-in.

## Run locally

```
cd orchestrator && npm install
# .dev.vars: OPENAI_API_KEY, DAYTONA_API_KEY, SPECTRON_URL, SPECTRON_CONTEXT_ID, SPECTRON_API_KEY, ANCHORBROWSER_API_KEY
npx wrangler dev
```
