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
| `POST /runs` | `{url, goal, id?, startedAt?}` | Creates a run, takes a first look and returns state with the first chat reply; report dissection starts after approval as described in the [workflow](spec.md#report-dissection) |
| `GET /runs/:id` | | Run state (`State` in [`run.ts`](../../orchestrator/src/run.ts)), with sandbox IDs removed by the front door, including an optional report defined by [`ReportDissection`](../../src/shared/report.ts) |
| `GET /runs/:id/preview` | | Optional `?variant=v1` selects a variant. Returns `{url}` with a 30-minute signed link and `Cache-Control: no-store`; 404 before a preview is available, for an unknown or failed variant, or after the run stops or expires |
| `GET /runs/:id/events?since=N` | | Events after `seq` N, oldest first |
| `GET /runs/:id/evidence/:evId` | | One of the run's evidence files (PNG, MP4, HTML or JSON), served sandboxed so captured pages never run |
| `POST /runs/:id/messages` | `{text}` | User chat message. The orchestrator replies and updates the spec. If the user clearly approves, it starts inspection |
| `POST /runs/:id/approve` | | Approve the spec explicitly. Inspection and website planning or report dissection run in the background; watch events |
| `POST /runs/:id/sign-in` | | Phase `awaiting_sign_in`: opens secure sign-in, an Anchor live session at the stopped page, and returns `{liveViewUrl}` (one-time; only in this reply, never in state or events). The user types their own credentials there |
| `POST /runs/:id/sign-in/resume` | | After sign-in: captures the stopped pages in that session, then plans (async; watch events) |
| `POST /runs/:id/sign-in/skip` | | Plans without the stopped pages (async) |
| `POST /runs/:id/build` | | Start website build. Needs phase `planned`, otherwise 500 with "No build started: tasks appear after the spec is approved." Report goals return 500 with "Report dissection does not start build workers" |
| `POST /runs/:id/report-edit` | `{figureId, edit: ReportEdit}` | Saves an edit to a known figure on a `done` report, emits `report`, and returns the updated `ReportDissection`; 500 for an incomplete report or unknown figure. Body validation is owned by [`runRoute`](../../src/worker/orchestrator/front.ts) and [`ReportEdit`](../../src/shared/report.ts) |
| `POST /runs/:id/stop` | | Stops the run: aborts backend fetches and body reads before further crawl requests, cancels active website inspection/planning and report capture/research, waits for [REA cleanup](spec.md#6-evidence), closes active Anchor sessions and saved sign-in sessions, and confirms worker cancellation or an already stopped, archived or deleted sandbox, then marks open tasks `stopped`; provider-read or cancellation failures keep `pending: "stop"` |
| `POST /runs/:id/override` | `{taskId, verdict: "approve"\|"reject", reason}` | User overrides a review verdict |
| `POST /runs/:id/variants` | | Needs phase `done`, scope `frontend` or `both`, a rebuild sandbox and no existing variant batch. Builds three landing-page variants from the merged rebuild (phase `variants`, back to `done` when they finish) |
| `POST /runs/:id/promote` | `{variantId}` | Needs phase `done` and a `ready` variant. Returns to `brief` for follow-up instructions; the next approved plan builds in the promoted sandbox. One promotion per run |
| `POST /gateway/capture` | `{runId, url}` | Sandbox network gateway (Bearer `GATEWAY_TOKEN`): a desktop screenshot through the evidence capture, recorded as run evidence, for pages in the run's approved scope only |
| `POST /gateway/remember`, `/gateway/recall` | `{runId, text, observedAt?}` / `{runId, query}` | Sandbox gateway to Cloudflare D1 and R2 Agent Memory (Bearer `GATEWAY_TOKEN`) |
| `POST /sandboxes/:id/captain`, `GET /sandboxes/:id/screen` | `{text}` | Types a captain message into the first mate's tmux pane, or reads that pane (Bearer `OPERATOR_TOKEN`) |

If `EVENTS_WEBHOOK_URL` is set, every event is also POSTed there as `{runId, seq, ts, type, data}`.

## Phases

`brief` → `inspecting` → `planning` → `planned` → `building` → `done` (→ `variants` → `done`), or `stopped` / `failed`.

Each run follows the [README's lifetime policy](../../README.md#sign-in-with-cloudflare-access). At the deadline the orchestrator stops the workers and every sandbox of the run,
emits `phase {phase: "stopped", reason: "time_limit"}`, and refuses further actions. Sandboxes also auto-stop after 60 idle minutes.
Foreground alarm work is cancelled at the deadline even if a provider remains stalled. Sandbox shutdown and worker termination run independently, with bounded waits and durable retries. Agent Memory stops between requests on cancellation; a sign-in saved after cancellation is forgotten independently of Anchor shutdown.

Legacy runs retain their stored creation timestamp, or use the original first-chat timestamp when creation time is missing or invalid. With neither valid timestamp, the run stops with an explicit error and immediate sandbox cleanup; no creation time or external run records are fabricated. Alarm scheduling always preserves an earlier pending cleanup or deadline.

Allocated sandbox IDs are saved before startup polling. Failed cleanup stays pending and is retried by alarms until Daytona confirms shutdown, including sandboxes that never finished starting. Stop durably marks cancellation pending before external cleanup; in-flight setup and workers cannot resume the run. Recovery to `planned`, `done`, or `stopped` is published to the event stream so the workspace offers the appropriate retry action.

Build setup can return `building` → `planned`; retry and cancellation behavior follow the [workspace guide](../../README.md#workspace).
Frontend inspection can pause in `awaiting_sign_in`; recovery is described under [Evidence capture](#evidence-capture).
The deadline is checked before paid work and on each alarm. Expiry persists pending sandbox cleanup and retries it by alarm. Stopped and failed runs refuse chat messages. Final verification completes before the phase becomes `done`; a final verification error marks the run `failed` unless cancellation is underway.
Overriding a completed run returns it to `building` for a main task or `variants` for a variant task when merging or requeuing is needed. If verification or lifecycle persistence fails, the run becomes `failed` and retains only its cleanup/deadline alarm, so paid verification is not retried automatically. Agent Memory reporting failures preserve completed lifecycle progress; active-slot retirement follows the [admission policy](../../README.md#sign-in-with-cloudflare-access).
For report phases see [Report dissection](spec.md#report-dissection).

## Events

`{seq, ts, type, data}`:

| type | data | UI |
|---|---|---|
| `chat` | `{role, text, ts}` | Chat panel |
| `spec` | `Spec` from [`types.ts`](../../orchestrator/src/types.ts) | Draft spec card. Unconfirmed items show "Not confirmed yet"; redirect presentation follows the [workspace guide](../../README.md#workspace) |
| `report` | [`ReportDissection`](../../src/shared/report.ts), including the latest edits | Report dissection card in the Spec canvas |
| `evidence` | `Evidence` from [`types.ts`](../../orchestrator/src/types.ts) | Screenshot, video and code evidence cards (`kind: "code"` items carry `summary` and `locator`); capture limits are in [Evidence](spec.md#6-evidence); missing screenshots follow the [workspace guide](../../README.md#workspace) |
| `plan` | `{tasks: Task[]}` | Kanban, all in Queued |
| `task` | Task | Move card: `queued`→Queued, `building`→Building, `in_review`→In review, `merged`→Merged; `failed`/`stopped` stay with `failure` and `nextAction` |
| `review` | `{taskId, verdict, reason, findings, diffStat}` | Review card on the task |
| `preview` | `{sandboxId?, mergedTask?, promoted?}` | The integration branch's preview changed (Daytona port 3000, private); fetch `GET /runs/:id/preview` for a signed link |
| `phase` | `{phase, ...}` | Header state; enable Start build on `planned` |
| `verification` | `{target, taskId?, pass, summary, findings, model}` | GPT verifier verdict on the plan, a merged task, or the final rebuild |
| `variant` | `Variant` from [`types.ts`](../../orchestrator/src/types.ts), with sandbox IDs removed by the front door | Variant card on the Preview tab |
| `error` | `{message}` | Inline error state |

## How a build runs

- The main rebuild starts in a Daytona sandbox (`daytona-medium`). The rebuild repo is at `/home/daytona/app` on `main`; additional sandboxes may be forked for [variants](#variants).
- Evidence is copied to `/home/daytona/evidence` and made read-only before any worker starts.
- Each task gets its own git worktree and branch `task/<id>`. A Codex worker (configured OpenAI model and reasoning) runs there.
  Codex's own sandbox cannot start inside the Daytona container, so the Daytona sandbox is the isolation boundary.
- A task is dispatched when all its dependencies are merged, up to `MAX_WORKERS` at once. The Durable Object alarm polls every 10 s.
- When a worker exits, the orchestrator commits its worktree, and GPT reviews the diff against the task, its acceptance criteria and the files it owns.
  Approve → `git merge --no-ff` into `main`, and the preview (scope-specific preview on port 3000) shows it. Reject → one revision with the review findings, then `failed` with the reason.
- If the verifier fails a merged task, the orchestrator persists one fix task `<id>-fix` on top of it, publishes task/variant outcomes, and schedules the build loop before reporting to Agent Memory. A fix task cannot generate another fix task. Reporting failures do not block the next build step or roll back merged work.
- Observations, plans and review verdicts are written to Cloudflare D1 and R2 Agent Memory under `org/reversy/run/<first 12 characters of the run ID>`.
- Events remain in the run's Durable Object event log. External Cloudflare D1 and R2 run records (run, events, tasks, steering, approvals)
  use one best-effort call per event through the `RECORDS` binding to the `reversy` Worker's `Records` entrypoint, which holds the credentials and has no HTTP route.
  Failed writes can leave missing events or partial projections, including steering, approvals and run updates; there is no durable replay or projection repair.
  Each failed call adds a local `error` event naming the affected sequence. These notices are not sent back to `RECORDS`.

## Variants

Three landing-page alternatives, each one task built and reviewed like any other, in a pod started from the merged rebuild's commit.
A pod is a Daytona fork of the run sandbox where the account allows it, otherwise a copy of the repo inside the run sandbox
(`/home/daytona/variants/<id>`, previewed on port 3001-3003), labelled `copy`. Each pod runs at most 2 workers at once.
Pods use the same scope-aware preview startup as the main rebuild ([`previewCommand`](../../orchestrator/src/scope.ts)); starting a follow-up build restarts its preview for the newly approved scope.
Promoting a copy merges it into `main`; promoting a fork makes it the run's sandbox and stops the other pods.
A variant becomes `ready` only when all its tasks are merged and verification passes, including any required fix task.
A failed review, failed fix verification, or unavailable verifier prevents promotion; existing `ready` status alone is insufficient.
Variant previews use the [preview route](#routes) under the same [run access policy](../../README.md#who-can-use-runs) as the rebuild. Signed links remain only in the requesting client; state, events, projections, model inputs and traces contain no preview capabilities. The run deadline still shuts the sandboxes down.
Promotion returns to the brief so the user can describe the next changes and approve a follow-up plan.
Starting that plan reuses the promoted sandbox and its merged files instead of creating a new sandbox.

## Verifier

The verifier is a GPT model: it runs on `VERIFIER_MODEL` (OpenAI, like every model in the demo) from Cloudflare,
outside the sandbox, with its own instructions. Its events carry the model name. It checks the plan before build, each merged task (against the live preview)
and the final rebuild, and emits the `verification` events described [above](#events).
A failed verdict is also posted to chat as steering. Tasks retain the boolean result in `verification`; absence means no completed check.
A task verifier-request error marks the task `failed` with its reason and a next action to approve its review to retry verification; the merged code stays in place.
No fix task is generated from an unavailable verifier. A plan-request failure leaves the run `failed`; final-check request failures mark the build failed instead of announcing completion.

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
- Deployment availability follows the [workspace guide](../../README.md#workspace).

## Run locally

```
npm install
npm install --prefix orchestrator
cd orchestrator
# .dev.vars: OPENAI_API_KEY, DAYTONA_API_KEY, ANCHORBROWSER_API_KEY,
#            DB and BLOBS (Wrangler bindings)
npx wrangler dev
```

For report runs, also configure the orchestrator's storage bindings from [Report dissection](spec.md#report-dissection).
