# Handoff: what the live Firstmate run taught us (branch `orchestrator`)

A run with Firstmate in a Daytona sandbox went end to end on 16 October: first mate on Codex `gpt-6.1-sol`,
foundation ship → no-mistakes review → PR #1 on the local git host → CI status success → merged under `+yolo`,
then 16 section ships dispatched in parallel. Notes for `main` (PR #8):

1. **Forgejo merges need a real commit status.** `bin/fm-pr-merge.sh` refuses a Forgejo/Gitea merge when the
   head's combined status is `none` ("an unconfigured status refuses"). With `no_ci: true` the foundation stops at
   `pr_ready`. Our fix: `sandbox/ci.mjs` posts a `reversy-ci/static` status per PR head (JS parses, HTML non-empty,
   `npm test` when defined).
2. **Codex trust prompts.** Every crewmate stops at "Do you trust the contents of this directory?" unless
   `~/.codex/config.toml` trusts both the project clone and `~/.treehouse`.
3. **`tea` via Go:** `code.gitea.io/tea@latest` resolves to a 2019 tag; the module is now `gitea.dev/tea@v0.16.0`.
4. **Network:** the org is now Daytona Tier 3, so new sandboxes reach Codeberg, Anchor and SurrealDB.
   Sandboxes created before the upgrade keep the old restricted egress.
5. **Bridge auth:** your run API expects `HMAC-SHA256(BRIDGE_TOKEN, runId)`; our bridge now needs only the derived
   token and the run id. The run API still answers 503 until the `SURREALDB_*` bindings are set.
6. **Role-scoped Agent Memory (SurrealDB prize):** the orchestrator Worker mints an attenuated Agent Memory key
   per role (`orchestrator/src/memory.ts`). Scopes: `org/reversy/site/<host>` (durable site knowledge),
   `run/<run>/shared` (first mate's plan), `run/<run>/task/<task>` (a crewmate's private notes), `user/<user>`.
   Verified: a crewmate writing another task's scope gets 403 from SurrealDB and cannot read it.
   Your `/runs/:id/memory` route could call the same scheme.

Live demo fallback: sandbox `0880ef74-6983-4480-860e-c89cc25ea4b8`, preview
https://3000-0880ef74-6983-4480-860e-c89cc25ea4b8.daytonaproxy01.eu.
