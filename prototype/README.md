# Python prototype (16 Oct 2026, morning)

The first version of the report idea, built before the team moved to the Cloudflare orchestrator.
Pipeline: fetch a public research report (trafilatura/Anchor) → extract figures with quotes (OpenAI) →
verify against primary data → write claims to SurrealDB Agent Memory → optional ElevenLabs voice summary.
Kept for reference; the live product is in `orchestrator/` and `src/`. Keys go in `.env` (see `.env.example`).
