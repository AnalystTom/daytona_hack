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
| `BRIDGE_TOKEN` | Shared secret the sandbox bridge sends as `Authorization: Bearer <token>` |
| `RUN_STORE` | Optional. `memory` keeps records in the Worker's memory instead, for local dev and tests only; it is honoured only for requests to `localhost` |

Without the SurrealDB bindings the run API answers 503 naming the missing ones; without `BRIDGE_TOKEN` the bridge routes do the same.

The store tests also run against a real SurrealDB when `SURREALDB_TEST_URL` (with `SURREALDB_TEST_USER` and `SURREALDB_TEST_PASSWORD`, root credentials) is set; they create a throwaway namespace there.

## Deploy

GitHub Actions (`.github/workflows/ci.yml`) runs format, lint, typecheck, test and build on every pull request and push.
On a push to `main`, once CI passes, the deploy job builds and deploys the Worker with the Cloudflare wrangler action.

The deploy job needs two repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Without them the deploy job fails, so a merge to `main` that did not deploy shows red.
