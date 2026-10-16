# Orchestrator API (for the Cloudflare backend)

The orchestrator is a Cloudflare Worker (`orchestrator/`) with one Durable Object per run.
It owns the phases from [`spec.md`](spec.md): brief (chat), inspect, plan, build and review.
Code is written only inside Daytona sandboxes, by Codex workers. Everything else runs on Cloudflare.

Call it through a service binding (`env.ORCHESTRATOR.fetch(...)`); it has no public address.

## Routes

| Method and path | Body | Does |
|---|---|---|
| `POST /runs` | `{url, goal}` | Creates a run, takes a first look (HTML, routes, an Anchor desktop screenshot of the start page), returns state with the first chat reply |
| `GET /runs/:id` | | Full state: `{id, phase, spec, chat, evidence, tasks, sandboxId, previewUrl, error}` |
| `GET /runs/:id/events?since=N` | | Events after `seq` N, oldest first |
| `GET /runs/:id/evidence/:evId` | | One of the run's evidence files from SurrealDB (PNG, MP4, HTML or JSON), served sandboxed so captured pages never run |
| `POST /runs/:id/messages` | `{text}` | User chat message. The orchestrator replies and updates the spec. If the user clearly approves, it starts inspection |
| `POST /runs/:id/approve` | | Approve the spec explicitly. Inspection and planning run in the background; watch events |
| `POST /runs/:id/sign-in` | | Phase `awaiting_sign_in`: opens secure sign-in, an Anchor live session at the stopped page, and returns `{liveViewUrl}` (one-time; only in this reply, never in state or events). The user types their own credentials there |
| `POST /runs/:id/sign-in/resume` | | After sign-in: captures the stopped pages in that session, then plans (async; watch events) |
| `POST /runs/:id/sign-in/skip` | | Plans without the stopped pages (async) |
| `POST /runs/:id/build` | | Start build. Needs phase `planned`, otherwise 500 with "No build started: tasks appear after the spec is approved." |
| `POST /runs/:id/stop` | | Stop build: kills workers, marks open tasks `stopped` |
| `POST /runs/:id/override` | `{taskId, verdict: "approve"\|"reject", reason}` | User overrides a review verdict |
| `POST /gateway/capture` | `{runId, url}` | Sandbox network gateway (Bearer `GATEWAY_TOKEN`): a desktop screenshot through the evidence capture, recorded as run evidence, for pages in the run's approved scope only |
| `POST /gateway/remember`, `/gateway/recall` | `{runId, text, observedAt?}` / `{runId, query}` | Sandbox gateway to SurrealDB Agent Memory (Bearer `GATEWAY_TOKEN`) |
| `POST /sandboxes/:id/captain`, `GET /sandboxes/:id/screen` | `{text}` | Types a captain message into the first mate's tmux pane, or reads that pane (Bearer `OPERATOR_TOKEN`) |

If `EVENTS_WEBHOOK_URL` is set, every event is also POSTed there as `{runId, seq, ts, type, data}`.

## Phases

`brief` → `inspecting` → `planning` → `planned` → `building` → `done`, or `stopped` / `failed`.
`inspecting` pauses in `awaiting_sign_in` when a page leaves the approved scope (usually a redirect to sign in), until the user signs in and resumes, or skips.

## Events

`{seq, ts, type, data}`:

| type | data | UI |
|---|---|---|
| `chat` | `{role, text, ts}` | Chat panel |
| `spec` | Spec (`pages[]`, `flows[]` with `confirmed`, `openQuestions[]`, `approved`, `revision`) | Draft spec card. Unconfirmed items show "Not confirmed yet" |
| `evidence` | Evidence (`id, page, kind, tool, status, capturedAt, hash, limits, summary, path?, url?`), one event per item as it is stored | Screenshot and video cards (`url` is set on observed screenshots and recordings). `status` is `observed`, `inferred` or `not_observed` |
| `plan` | `{tasks: Task[]}` | Kanban, all in Queued |
| `task` | Task | Move card: `queued`→Queued, `building`→Building, `in_review`→In review, `merged`→Merged; `failed`/`stopped` stay with `failure` and `nextAction` |
| `review` | `{taskId, verdict, reason, findings, diffStat}` | Review card on the task |
| `preview` | `{url, sandboxId?, mergedTask?}` | Live preview of the integration branch (Daytona port 3000, public) |
| `phase` | `{phase, ...}` | Header state; enable Start build on `planned` |
| `verification` | `{target, taskId?, pass, summary, findings}` | Verifier verdict on the plan, a merged task, or the final rebuild |
| `error` | `{message}` | Inline error state |

## How a build runs

- One Daytona sandbox per run (`daytona-medium`). The rebuild repo is at `/home/daytona/app` on `main`.
- Evidence is copied from SurrealDB to `/home/daytona/evidence` and made read-only before any worker starts.
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
(reads included; `sandboxId` is dropped from every `/api/v1/runs` JSON reply, state and events included).
`orchestrator/scripts/demo-run.sh` drives one full run that way (set `REVERSY_URL` and `OPERATOR_TOKEN`).

## Evidence capture

The orchestrator uses Reversy's evidence capture (`src/worker/evidence`) with `ANCHORBROWSER_API_KEY`, and stores every record and file in SurrealDB (`SURREALDB_*`).

- First look: one desktop screenshot of the start page.
- Full pack, after the spec is approved, for up to 10 confirmed pages (the rest are named in chat): desktop and mobile screenshots, rendered DOM, computed styles and design tokens, assets, and the page-load network log, plus one recording of the capture session paused at 30 seconds.
- Scope guard: a page that redirects or moves outside the approved origin and paths stops; its remaining items are `not_observed` with the reason.
- Signed-in capture records screenshots only (Anchor's sensitive-data mask is on); DOM, assets, network and the recording are `not_observed` so account data and the sign-in are never stored.
- Missing bindings are named in the error, never faked.

## Not built yet

- Variant pods (fork).

## Run locally

```
cd orchestrator && npm install
# .dev.vars: OPENAI_API_KEY, DAYTONA_API_KEY, SPECTRON_URL, SPECTRON_CONTEXT_ID, SPECTRON_API_KEY, ANCHORBROWSER_API_KEY,
#            SURREALDB_URL, SURREALDB_NAMESPACE, SURREALDB_DATABASE, SURREALDB_USER, SURREALDB_PASSWORD
npx wrangler dev
```
