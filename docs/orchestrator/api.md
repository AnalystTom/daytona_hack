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
| `GET /runs/:id/preview` | | `{url}`: a 30-minute signed link to the private sandbox preview; 404 before the build serves one or after the run stops |
| `GET /runs/:id/events?since=N` | | Events after `seq` N, oldest first |
| `GET /runs/:id/evidence/:evId` | | One of the run's evidence files (PNG, MP4, HTML or JSON), served sandboxed so captured pages never run |
| `POST /runs/:id/messages` | `{text}` | User chat message. The orchestrator replies and updates the spec. If the user clearly approves, it starts inspection |
| `POST /runs/:id/approve` | | Approve the spec explicitly. Inspection and planning run in the background; watch events |
| `POST /runs/:id/sign-in` | | Phase `awaiting_sign_in`: opens secure sign-in, an Anchor live session at the stopped page, and returns `{liveViewUrl}` (one-time; only in this reply, never in state or events). The user types their own credentials there |
| `POST /runs/:id/sign-in/resume` | | After sign-in: captures the stopped pages in that session, then plans (async; watch events) |
| `POST /runs/:id/sign-in/skip` | | Plans without the stopped pages (async) |
| `POST /runs/:id/build` | | Start build. Needs phase `planned`, otherwise 500 with "No build started: tasks appear after the spec is approved." |
| `POST /runs/:id/stop` | | Stops the run: cancels active inspection and planning writes, closes active Anchor sessions and saved sign-in sessions, kills workers and marks queued/building tasks `stopped` |
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
| `spec` | `Spec` from [`types.ts`](../../orchestrator/src/types.ts) | Draft spec card. Unconfirmed items show "Not confirmed yet"; redirect presentation follows the [workspace guide](../../README.md#workspace) |
| `evidence` | `Evidence` from [`types.ts`](../../orchestrator/src/types.ts) | Screenshot / evidence cards; capture limits are in [Evidence](spec.md#6-evidence); missing screenshots follow the [workspace guide](../../README.md#workspace) |
| `plan` | `{tasks: Task[]}` | Kanban, all in Queued |
| `task` | Task | Move card: `queued`→Queued, `building`→Building, `in_review`→In review, `merged`→Merged; `failed`/`stopped` stay with `failure` and `nextAction` |
| `review` | `{taskId, verdict, reason, findings, diffStat}` | Review card on the task |
| `preview` | `{sandboxId?, mergedTask?}` | The integration branch's preview changed (Daytona port 3000, private); fetch `GET /runs/:id/preview` for a signed link |
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
  Approve → `git merge --no-ff` into `main`, and the preview on port 3000 shows it (`npx serve` for frontend scope, the Node.js service for backend or combined scope; see [`previewCommand`](../../orchestrator/src/scope.ts)). Reject → one revision with the review findings, then `failed` with the reason.
- Observations, plans and review verdicts are written to SurrealDB Agent Memory under `org/reversy/run/<id>`.

## Verifier

The [agent spec's verifier contract](spec.md#9-verifier) defines plan, task and final checks, including scope-specific preview inspection and route-probe limits. Results arrive as `verification` events above.

## Deployed

No public address: `workers_dev` and `preview_urls` are off. The `reversy` Worker reaches it through its `ORCHESTRATOR` service binding,
the workspace through `/api/v1/runs/*` and operators through `/api/v1/orchestrator/*`, both with `Authorization: Bearer <OPERATOR_TOKEN>`
(reads included; `sandboxId` is dropped from `/api/v1/runs` state and event JSON replies; evidence files retain their stored bytes unchanged).
`/api/v1/runs/*` also accepts the signed session cookie that `POST /api/v1/session` sets on this site (see the README's Run API).
`orchestrator/scripts/demo-run.sh` drives one full run that way (set `REVERSY_URL` and `OPERATOR_TOKEN`).

## Evidence capture

The orchestrator uses Reversy's evidence capture (`src/worker/evidence`) with `ANCHORBROWSER_API_KEY`, and stores new records and files in SurrealDB (`SURREALDB_*`). Persisted legacy evidence remains readable from the run's Durable Object blobs; both storage paths require the evidence ID to belong to the run.

- Redirects: before scoping, the orchestrator follows the entered URL's redirects (GET, up to 5 hops, a 10-second timeout per request). Each destination must pass the run URL check: https, no credentials and a public literal host; DNS resolution is not checked. An unsafe destination is not fetched and is noted in the evidence limits; a failed request or invalid redirect ends resolution. The last accepted URL becomes the run's `spec.url`, so its origin is the approved origin. When a redirect is followed or blocked as unsafe, an observed `redirects` evidence item records the result. Redirects during capture keep the scope guard below.
- First look: one desktop screenshot of the start page; missing-evidence presentation follows the [workspace guide](../../README.md#workspace).
- Full pack, after the spec is approved: the artifacts and signed-in restrictions in the [evidence contract](spec.md#6-evidence), for up to 10 confirmed pages per pass (the rest are named in chat). The session recording is paused at 30 seconds, or ends sooner with capture; if pausing fails, it is not kept.
- Scope guard: the resolved target query state is preserved through first look, approved-page capture, the gateway and sign-in recovery. A page that redirects or moves outside the requested page's origin, path or explicitly scoped query stops; its remaining items are `not_observed` with the reason. Query state remains in stored evidence but is redacted from evidence event labels and progress messages.
- Secure sign-in: use **Open secure sign-in**, sign in yourself in the new Anchor tab, then **Resume capture**. If the session is missing or expired, the run returns to `awaiting_sign_in`; open sign-in again or choose **Skip sign-in** to plan without the stopped pages. Opening sign-in again replaces and closes the prior saved session; skipping or stopping closes it too. Session-close failures fall back to Anchor's timeout.
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
