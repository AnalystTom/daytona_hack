# Orchestrator API (for the Cloudflare backend)

The orchestrator is a Cloudflare Worker (`orchestrator/`) with one Durable Object per run.
It owns the phases from [`spec.md`](spec.md): brief (chat), inspect, plan, build and review.
Code is written only inside Daytona sandboxes, by Codex workers. Everything else runs on Cloudflare.
Report runs use the separate [report-dissection workflow](spec.md#report-dissection).

Call it through a service binding (`env.ORCHESTRATOR.fetch(...)`); it has no public address.

The front door supplies `id` and `startedAt` after atomically reserving ownership and limits; the timestamp is the admission time, so delayed starts cannot extend their deadline. Operator fallback callers may omit both. An existing run cannot be started again.

## Routes

| Method and path | Body | Does |
|---|---|---|
| `POST /runs` | `{url, goal, id?, startedAt?}` | Creates a run and returns state with the first chat reply; website briefs take a first look, while a brief that explicitly asks to reconstruct or dissect a report schedules dissection once approved (see [workflow](spec.md#report-dissection)) |
| `GET /runs/:id` | | Full run state (`State` in [`run.ts`](../../orchestrator/src/run.ts)), including an optional report defined by [`ReportDissection`](../../src/shared/report.ts) |
| `GET /runs/:id/preview` | | `{url}`: a 30-minute signed link to the private sandbox preview; 404 before the build serves one or after the run stops |
| `GET /runs/:id/events?since=N` | | Events after `seq` N, oldest first |
| `GET /runs/:id/evidence/:evId` | | One of the run's evidence files (PNG, MP4, HTML or JSON), served sandboxed so captured pages never run |
| `POST /runs/:id/messages` | `{text}` | User chat message. The orchestrator replies and updates the spec. If the user clearly approves, it starts inspection |
| `POST /runs/:id/approve` | | Approve the spec explicitly. Inspection and website planning or report dissection run in the background; watch events |
| `POST /runs/:id/sign-in` | | Phase `awaiting_sign_in`: opens secure sign-in, an Anchor live session at the stopped page, and returns `{liveViewUrl}` (one-time; only in this reply, never in state or events). The user types their own credentials there |
| `POST /runs/:id/sign-in/resume` | | After sign-in: captures the stopped pages in that session, then plans (async; watch events) |
| `POST /runs/:id/sign-in/skip` | | Plans without the stopped pages (async) |
| `POST /runs/:id/build` | | Start website build. Needs phase `planned`, otherwise 500 with "No build started: tasks appear after the spec is approved." Report goals return 500 with "Report dissection does not start build workers" |
| `POST /runs/:id/report-edit` | `{figureId, edit: ReportEdit}` | Saves an edit to a known figure on a `done` report, emits `report`, and returns the updated `ReportDissection`; 500 for an incomplete report or unknown figure. Body validation is owned by [`runRoute`](../../src/worker/orchestrator/front.ts) and [`ReportEdit`](../../src/shared/report.ts) |
| `POST /runs/:id/stop` | | Stops the run: aborts backend fetches and body reads before further crawl requests, cancels active website inspection/planning and report capture/research, closes active Anchor sessions and saved sign-in sessions, and confirms worker cancellation or an already stopped, archived or deleted sandbox, then marks open tasks `stopped`; provider-read or cancellation failures keep `pending: "stop"` |
| `POST /runs/:id/override` | `{taskId, verdict: "approve"\|"reject", reason}` | User overrides a review verdict |
| `POST /gateway/capture` | `{runId, url}` | Sandbox network gateway (Bearer `GATEWAY_TOKEN`): a desktop screenshot through the evidence capture, recorded as run evidence, for pages in the run's approved scope only |
| `POST /gateway/remember`, `/gateway/recall` | `{runId, text, observedAt?}` / `{runId, query}` | Sandbox gateway to SurrealDB Agent Memory (Bearer `GATEWAY_TOKEN`) |
| `POST /sandboxes/:id/captain`, `GET /sandboxes/:id/screen` | `{text}` | Types a captain message into the first mate's tmux pane, or reads that pane (Bearer `OPERATOR_TOKEN`) |

If `EVENTS_WEBHOOK_URL` is set, every event is also POSTed there as `{runId, seq, ts, type, data}`.

## Phases

`brief` → `inspecting` → `planning` → `planned` → `building` → `done`, or `stopped` / `failed`.
Frontend inspection can pause in `awaiting_sign_in`; recovery is described under [Evidence capture](#evidence-capture).
Before paid work and on each alarm, the orchestrator applies the [README's lifetime policy](../../README.md#sign-in-with-cloudflare-access). Expiry uses the same confirmed-cancellation path as explicit stop; cancellation failures leave the run stopping and block further work. Stopped and failed runs refuse chat messages. Final verification completes before the phase becomes `done`; a final verification error marks the run `failed` unless cancellation is underway.
Overriding a completed run returns it to `building` when a task needs merging or requeuing. If that continuation fails, the run becomes `failed` and its alarm is removed, so paid verification is not retried automatically; active-slot retirement follows the [admission policy](../../README.md#sign-in-with-cloudflare-access).
For report phases see [Report dissection](spec.md#report-dissection).

## Events

`{seq, ts, type, data}`:

| type | data | UI |
|---|---|---|
| `chat` | `{role, text, ts}` | Chat panel |
| `spec` | `Spec` from [`types.ts`](../../orchestrator/src/types.ts) | Draft spec card. Unconfirmed items show "Not confirmed yet"; redirect presentation follows the [workspace guide](../../README.md#workspace) |
| `report` | [`ReportDissection`](../../src/shared/report.ts), including the latest edits and replay metadata when present | Report dissection card in the Spec canvas |
| `evidence` | `Evidence` from [`types.ts`](../../orchestrator/src/types.ts) | Screenshot / evidence cards; capture limits are in [Evidence](spec.md#6-evidence); missing screenshots follow the [workspace guide](../../README.md#workspace) |
| `evidence_reset` | `{}` | Clears previous capture cards before replay evidence is emitted; evidence URLs use the replaying run's ID, whose evidence handler forwards internally to the originating successful run |
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
- Each task gets its own git worktree and branch `task/<id>`. A Codex worker runs there; model, reasoning and concurrency follow the [agent configuration](spec.md#4-agents) and [scheduling rules](spec.md#7-orchestration).
  Codex's own sandbox cannot start inside the Daytona container, so the Daytona sandbox is the isolation boundary.
- A task is dispatched when all its dependencies are merged, up to `MAX_WORKERS` at once. The Durable Object alarm polls every 10 s.
- When a worker exits, the orchestrator commits its worktree, and GPT reviews the diff against the task, its acceptance criteria and the files it owns.
  Approve → `git merge --no-ff` into `main`, and the preview on port 3000 shows it (`npx serve` for frontend scope, the Node.js service for backend or combined scope; see [`previewCommand`](../../orchestrator/src/scope.ts)). Reject → one revision with the review findings, then `failed` with the reason.
- Observations, plans and review verdicts are written to SurrealDB Agent Memory under `org/reversy/run/<id>`.

## Verifier

The [agent spec's verifier contract](spec.md#9-verifier) defines plan, task and final checks, including scope-specific preview inspection and route-probe limits. Results arrive as `verification` events above.

## Deployed

No public address: `workers_dev` and `preview_urls` are off. The `reversy` Worker reaches it through its `ORCHESTRATOR` service binding.
The public `/api/v1/runs/*` front door and operator proxy follow the [README's access policy](../../README.md#who-can-use-runs); `sandboxId` is dropped from front-door state and event JSON replies; captured evidence files retain their stored bytes unchanged.
`orchestrator/scripts/demo-run.sh` drives one full run with `REVERSY_URL` and `OPERATOR_TOKEN` (operator bearer, so only before Access setup).

## Evidence capture

For browser evidence, the orchestrator uses Reversy's evidence capture (`src/worker/evidence`) with `ANCHORBROWSER_API_KEY`. Backend inspection and evidence storage are described in the [agent spec](spec.md#6-evidence) and its [records contract](spec.md#12-records). Persisted legacy evidence remains readable from the run's Durable Object blobs; both storage paths require the evidence ID to belong to the run. Report capture follows the [report workflow](spec.md#report-dissection).

- Redirects: before scoping, the orchestrator follows the entered URL's redirects (GET, up to 5 hops, a 10-second timeout per request). Each destination must pass the run URL check: https, no credentials and a public literal host; DNS resolution is not checked. An unsafe destination is not fetched and is noted in the evidence limits; a failed request or invalid redirect ends resolution. The last accepted URL becomes the run's `spec.url`, so its origin is the approved origin. When a redirect is followed or blocked as unsafe, an observed `redirects` evidence item records the result. Redirects during capture keep the scope guard below.
- First look: one desktop screenshot of the start page; missing-evidence presentation follows the [workspace guide](../../README.md#workspace).
- Full pack, after the spec is approved: the artifacts and signed-in restrictions in the [evidence contract](spec.md#6-evidence), for up to 10 confirmed pages per pass (the rest are named in chat). The session recording is paused at 30 seconds, or ends sooner with capture; if pausing fails, it is not kept.
- Browser scope guard: the resolved target query state is preserved through first look, approved-page capture, the gateway and sign-in recovery. With code execution, navigation and each screenshot report the browser's final URL. A page that redirects or moves outside the requested page's origin, path or explicitly scoped query stops; its remaining items and the session recording are `not_observed` with the reason. Browser-capture query state remains in stored evidence but is redacted from evidence event labels and progress messages.
- Screenshot fallback: when Anchor refuses the navigation snippet, captures without sign-in use the screenshot tool for the rest of that capture pass, passing the existing session ID to preserve its sensitive-data mask. First look still requests desktop screenshots, and full pack requests desktop and mobile screenshots; DOM, styles, assets, network and recording are `not_observed`. Before capture, an HTTP redirect preflight applies the run URL checks above to every hop, with a 10-second timeout per request and up to 5 redirects; a known off-scope landing URL stops the page. An unsafe hop, malformed redirect, failed request or excessive redirects marks that page's remaining items `not_observed` and continues with the next approved page. The tool cannot report the final browser URL after scripts, so its screenshots are `inferred`, with the limitation: "captured with the fallback screenshot tool; the final page URL after scripts could not be verified, so it may show a redirect such as a sign-in page". Inferred files remain available in evidence events, gateway responses and worker attachments; canvas presentation follows the [workspace guide](../../README.md#workspace). Signed-in capture still requires code execution and does not use this fallback.
- Secure sign-in: use **Open secure sign-in**, sign in yourself in the new Anchor tab, then **Resume capture**. If the session is missing or expired, the run returns to `awaiting_sign_in`; open sign-in again or choose **Skip sign-in** to plan without the stopped pages. Opening sign-in again replaces and closes the prior saved session; skipping or stopping closes it too. Session-close failures fall back to Anchor's timeout.
- Missing bindings are named in the error, never faked.

## Not built yet

- Website capture limitations are described under [evidence capture](../../README.md#evidence-capture); report capture has its own [limits](spec.md#report-dissection).
- Variant pods (fork).

## Run locally

```
npm install
npm install --prefix orchestrator
cd orchestrator
# .dev.vars: OPENAI_API_KEY, DAYTONA_API_KEY, SPECTRON_URL, SPECTRON_CONTEXT_ID, SPECTRON_API_KEY, ANCHORBROWSER_API_KEY,
#            SURREALDB_URL, SURREALDB_NAMESPACE, SURREALDB_DATABASE, SURREALDB_USER, SURREALDB_PASSWORD
npx wrangler dev
```

For report runs, also configure the orchestrator's storage bindings from [Report dissection](spec.md#report-dissection).
