# Reversy

Reversy takes a site apart and rebuilds it with agents. The product spec is in `docs/spec.md` and the agent system in `docs/orchestrator/spec.md`.

This repository is one TypeScript project deployed as a single Cloudflare Worker named `reversy`:

- `src/web/`: React front end, built with Vite and served as Workers static assets.
- `src/worker/`: the Worker, which handles `/api/*` (for example `GET /api/health`).
- `src/shared/`: contracts used by both, as zod schemas with their TypeScript types.

## Setup

Requires Node 22.

```sh
npm install
npm run dev
```

`npm run dev` serves the front end and the Worker together through the Cloudflare Vite plugin.
The workspace is at `/workspace`; in development only (`npm run dev`), `/workspace?fixture=spec` shows it with labelled sample data for design review; production builds leave fixture mode out.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Local dev server for the app and API |
| `npm run build` | Builds the front end and the Worker into `dist/` |
| `npm run typecheck` | Type-checks the web and Worker code |
| `npm run lint` | Lints with Biome |
| `npm run format` | Checks formatting with Biome (`npx biome format --write .` fixes it) |
| `npm test` | Runs the Vitest tests |
| `npm run deploy` | Builds, then runs `wrangler deploy` |

## Worker bindings

| Binding | Used by | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` (secret) | The verifier, `POST /api/v1/runs/:id/verify` | The endpoint returns 503 naming the missing binding |
| `VERIFIER_TOKEN` (secret) | Callers of the verify endpoint send `Authorization: Bearer <VERIFIER_TOKEN>`; a wrong or missing token gets 401 | The endpoint returns 503 naming the missing binding |

Set a secret with `npx wrangler secret put <NAME>`.

## Verifier

`POST /api/v1/runs/:id/verify` checks the orchestrator's output with `claude-opus-5-5` at high effort (`docs/orchestrator/spec.md` section 7).
The body is `{kind: "plan" | "task" | "final", spec, evidence, findings, screenshots, plan}`, plus `task` for `kind: "task"` and `rebuildEvidenceIds` for `kind: "final"`; the schemas are in `src/shared/verifier.ts`.
It returns `{runId, kind, model, verdict: "pass" | "fail", summary, findings}`, where each finding names a plan item (or `null` for something missing from the plan) and evidence IDs.
A model error, refusal, truncated reply or malformed verdict returns 502, never a pass.

## Run API

The Worker serves the run API under `/api/v1/runs` (see `docs/orchestrator/spec.md` sections 2, 4 and 10, and `src/shared/runs.ts` for the request and response shapes):

| Route | Who calls it | What it does |
|---|---|---|
| `POST /runs` | UI | Creates a run from `{url, goal}`; the URL must be https, without credentials, on a public host |
| `GET /runs/:id` | UI | The run and its tasks |
| `POST /runs/:id/messages` | UI | A chat message `{text}` for Firstmate |
| `GET /runs/:id/events` | UI, bridge | Server-sent events; reconnecting with `Last-Event-ID` replays what was missed |
| `POST /runs/:id/events` | Sandbox bridge | One `EventEnvelope` or a batch; duplicate event IDs are ignored |
| `POST`/`GET /runs/:id/memory` | Sandbox bridge | Agent Memory: observations and decisions with their sources |
| `POST /runs/:id/approve-spec` | UI | Records the user's spec approval |
| `POST /runs/:id/stop` | UI | Stops the run |

The API assigns each stored event its `sequence` (1, 2, ...) in arrival order and writes it to SurrealDB before any stream sends it.
Errors are `{code, message, retryable, requestId}`.

### Bindings

Set these as Worker secrets or variables (for local dev, in `.dev.vars`):

| Binding | Used for |
|---|---|
| `SURREALDB_URL` | SurrealDB 3.x HTTP base URL, for example `https://<instance>.surreal.cloud` |
| `SURREALDB_NAMESPACE` | Namespace holding Reversy's records (it must already exist) |
| `SURREALDB_DATABASE` | Database inside that namespace (it must already exist) |
| `SURREALDB_USER` | SurrealDB user the Worker signs in as |
| `SURREALDB_PASSWORD` | That user's password |
| `BRIDGE_TOKEN` | Worker secret the bridge routes verify against: a bridge sends `Authorization: Bearer <HMAC-SHA256(BRIDGE_TOKEN, runId)>` (hex, `runBridgeToken`) for the run id in the URL; the raw secret is not accepted |
| `OPERATOR_TOKEN` | Interim operator secret; `POST /runs` requires it as `Authorization: Bearer <token>` |

Without the SurrealDB bindings the run API answers 503 naming the missing ones; without `BRIDGE_TOKEN` the bridge routes do the same, and without `OPERATOR_TOKEN` so does `POST /runs`.
A missing or wrong token answers 401.

Interim access policy: only creating a run (which will start a paid sandbox) needs the operator token.
Every other run route treats the random run ID as its capability: whoever has the ID can read the run, stream its events, chat, approve the spec and stop it.
There is no user identity, run ownership or rate limiting yet.

The store tests also run against a real SurrealDB when `SURREALDB_TEST_URL` (with `SURREALDB_TEST_USER` and `SURREALDB_TEST_PASSWORD`, root credentials) is set; they create a throwaway namespace there.

## Deploy

GitHub Actions (`.github/workflows/ci.yml`) runs format, lint, typecheck, test and build on every pull request and push.
On a push to `main`, once CI passes, the deploy job builds and deploys the Worker with the Cloudflare wrangler action.

The deploy job needs two repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Without them the deploy job fails, so a merge to `main` that did not deploy shows red.

## Run sandbox (Daytona)

Each run gets one Daytona sandbox that holds the agent system (`docs/orchestrator/spec.md` sections 2, 3 and 6): Firstmate as orchestrator, Codex workers on `gpt-6.1-sol` at high reasoning, no-mistakes review, Forgejo with `tea` for pull requests, a preview server and the bridge.
The agents run and execute code only inside that sandbox; the service stays on Cloudflare, and the sandbox keeps no durable records of its own: the bridge reports to the Worker, which owns storage.

- `src/worker/daytona/`: the Daytona adapter (`client.ts`), run lifecycle (`lifecycle.ts`) and its routes (`routes.ts`).
- `sandbox/`: the snapshot (`Dockerfile`, `setup.sh`, pinned versions in `versions.env`), the scripts the Worker runs inside a sandbox, and the bridge (`sandbox/bridge/bridge.ts`).

The adapter calls Daytona's REST API with `fetch`, following the paths and payloads of the official TypeScript SDK `@daytona/sdk` 0.224.1 (and its `@daytona/api-client` 0.224.1), checked against Daytona's docs on 2026-10-16.
The SDK itself is not bundled because it depends on Node-only packages that the Worker does not need.

### Bindings

| Binding | Needed for |
|---|---|
| `SANDBOX_API_TOKEN` | Every sandbox route: callers send it as `Authorization: Bearer`, because these routes spend money and instruct agents that hold secrets |
| `DAYTONA_API_KEY` | Every sandbox route |
| `OPENAI_API_KEY` | Starting a run sandbox or a pod: Codex signs in with it inside the sandbox |
| `BRIDGE_TOKEN` | Starting a run sandbox or a pod: never sent to a sandbox; each run's bridge gets only `HMAC-SHA256(BRIDGE_TOKEN, runId)` (hex, `runBridgeToken` in `src/worker/daytona/bridge-token.ts`) and sends that as `Authorization: Bearer` |
| `DAYTONA_SNAPSHOT` (optional) | Snapshot name; defaults to `reversy-run` |
| `DAYTONA_API_URL` (optional) | Daytona API base; defaults to `https://app.daytona.io/api` |

A route whose bindings are missing answers 503 and lists them by name; a caller without the right token gets 401.
Other Worker code can call the lifecycle functions in `lifecycle.ts` directly instead of going through these routes.
The run API's bridge routes derive that same token for the run id in the URL, so a run's token works only for that run.
Secrets reach the sandbox through the toolbox at boot (`sandbox/save-env.sh`, owner-only files), never through Daytona's sandbox metadata or the snapshot.

### Routes

| Route | What it does |
|---|---|
| `POST /api/v1/runs/:id/sandbox` | Creates the run's sandbox from the snapshot (or restarts a stopped one) and starts `boot.sh`; returns the existing sandbox if it is running and booted, and reruns `boot.sh` if its boot failed or never started |
| `GET /api/v1/runs/:id/sandbox` | State, boot status and log tail, and a signed preview URL (port 4173, valid for an hour) |
| `POST /api/v1/runs/:id/sandbox/messages` | `{ kind: "chat" \| "approved_spec", text, podId? }`: pastes the message into Firstmate's session as captain input |
| `POST /api/v1/runs/:id/pods` | `{ fromSandboxId? }`: creates a variant pod with Daytona fork, or a snapshot copy when fork is refused; the answer says `"fork"` or `"copy"` |
| `DELETE /api/v1/runs/:id/sandbox` | Deletes the run's pods, copy snapshots and sandbox; answers 200 with the report, or 502 with each failure |

Sandboxes are found by their labels (`reversy.run`, `reversy.role`), so the Worker holds no sandbox state.
Auto-stop is off, because agents keep working without toolbox traffic; a 12-hour wall-clock TTL backstops a run whose cleanup never arrives.

### Inside the sandbox

`boot.sh` sets up, once, and then starts each of these in its own tmux session:

- Forgejo on `localhost:3000` with a `reversy` admin and the `reversy/rebuild` repository, and a `tea` login for it.
- The Firstmate home at `~/firstmate` (pinned commit of `https://github.com/kunchenguid/firstmate`) with one project, `rebuild [no-mistakes +yolo forge=forgejo]`, cloned from Forgejo and initialised for no-mistakes; workers on Codex with `gpt-6.1-sol` at high effort (`config/crew-harness`, `config/crew-dispatch.json`).
- Firstmate itself (Codex, same model) in session `firstmate`; captain input is pasted there.
- The preview server on port 4173, serving `main` from Forgejo and rebuilding it after every merge.
- The bridge, which every 5 seconds posts new `EventEnvelope` batches to `POST /api/v1/runs/:id/events`: `task.status` (each line of a Firstmate status file), `backlog.item` (a task changing column) and `pull_request` (a pull request opening, merging or closing). Event ids are stable, so a retried post deduplicates; events from a pod carry `pod:<podId>` in `artifactRefs` and a `<podId>/<taskId>` task id, and a new pod posts only what changes after it starts.

### Building the snapshot

Install the [Daytona CLI](https://www.daytona.io/docs/en/tools/cli.md), sign in, then from the repository root:

```sh
daytona snapshot create reversy-run --dockerfile sandbox/Dockerfile --context sandbox --cpu 4 --memory 8 --disk 20
```

`setup.sh` installs the pinned versions in `sandbox/versions.env` (Node, Git, Codex CLI, no-mistakes, Forgejo, `tea`, and the Firstmate commit), verifies every download's SHA-256, and skips anything already at its pin, so it is safe to re-run.
To change a version, edit `versions.env` and build a new snapshot.

Daytona forks only Linux VM sandboxes, and builds from a Dockerfile only for containers.
Until VM fork is enabled on the account, pods are snapshot copies: the parent is stopped for the cold snapshot and restarted afterwards.
To use fork, push the image built from `sandbox/Dockerfile` to a registry and create the snapshot from it with `--image <image> --sandbox-class linux-vm`.

Not yet verified against live services: `gpt-6.1-sol` through Codex in the sandbox, and no-mistakes against Forgejo (both open questions in the agent system spec).

## Evidence capture

`src/worker/evidence/` captures evidence for a run's approved pages with [Anchor Browser](https://docs.anchorbrowser.io) and stores each item, with its file, in SurrealDB.
It is built against Anchor's REST API v1 (OpenAPI 1.0.0, docs read on 2026-10-16): `POST /v1/sessions`, `POST /v1/tools/execute-code` (Playwright snippets in the session), `GET /v1/sessions/{id}/recordings`, `GET /v1/sessions/{id}/recordings/primary/fetch` and `DELETE /v1/sessions/{id}`.
Anchor has no dedicated DOM or network-log endpoint, so the DOM snapshot, computed design tokens, asset list and network log (URLs, statuses, types and JSON response shapes, without headers or bodies) come from the snippet.
Interaction recordings are not captured yet; a full pack keeps the session's page-load recording, and none in a signed-in session.

| Endpoint | What it does |
|---|---|
| `POST /api/v1/runs/:id/capture` | Body `{ mode: "first_look" \| "full_pack", scope: { origin, paths }, signIn?: "start" \| "resume" }`. `first_look` takes a desktop screenshot of each path; `full_pack` adds a mobile screenshot, DOM, styles, assets, network and the recording. `signIn: "start"` returns an Anchor live-view URL where the user signs in themselves; `"resume"` captures in that session. |
| `GET /api/v1/evidence/:id` | The evidence record (shared `EvidenceRecord` in `src/shared/evidence.ts`). |
| `GET /api/v1/evidence/:id/content` | The stored file. |

Only the approved origin and paths are captured; a page that redirects anywhere else is stopped and its items are stored as `not_observed` with the reason.
Until the run API's event function is on `main`, capture events are returned in the capture response, and `captureRun` takes an `emit` function.

Worker bindings (secrets, set with `wrangler secret put`):

- `ANCHOR_API_KEY`
- `SURREALDB_URL` (the SurrealDB HTTP base URL; requests go to its `/rpc` endpoint)
- `SURREALDB_NAMESPACE`
- `SURREALDB_DATABASE`
- `SURREALDB_USERNAME`
- `SURREALDB_PASSWORD`

Without them the endpoints answer `503` and list the missing names.
Tests use fixture responses in `src/worker/evidence/fixtures.ts`, built from Anchor's and SurrealDB's documented shapes rather than recorded from live calls.
