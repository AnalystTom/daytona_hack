# Reversy: Take it apart. Make it yours.

## Summary
Reversy is a reverse-engineering agent system. You give it a website and a goal in chat. Agents capture evidence
from the real site, agree a spec with you, and a crew of Codex agents rebuilds it in parallel inside a Daytona
sandbox. Every change is reviewed, checked and merged against that evidence, with a live preview you can watch.

## Problem and impact
Teams rebuild, migrate and redesign existing products all the time, and most of that work is manual
archaeology: screenshots, copied styles, guessed API shapes. Agents can do it faster, but only if they are
grounded in what the original actually does and kept from running wild. Reversy makes every feature trace back to
observed evidence, runs untrusted agent code only in an isolated sandbox, and puts a review gate and a human
captain in front of every merge.

## How it works
- **Chat → spec:** the user talks to the first mate (Firstmate, the orchestrator) as its captain; the spec marks
  anything not agreed as "not confirmed yet".
- **Evidence:** Anchor captures desktop and mobile screenshots and the rendered DOM; each item has an id, tool,
  hash and an observed / inferred / not observed label, stored read-only for the crew.
- **Crew:** Firstmate splits the work (foundation first, then one ship per landing-page section) and dispatches
  Codex workers (`gpt-6.1-sol`, high reasoning), each in its own git worktree.
- **Review and merge:** each ship goes through the no-mistakes gate (review, tests, docs), opens a pull request on
  the run's own git host, gets a CI status, and merges; a preview server shows the integration branch live.
- **Bridge:** Firstmate's fleet ledger becomes Queued → Building → In review → Merged events on the kanban, and the
  first mate's replies show up in chat.

## Safeguards
- All agent code runs only inside a Daytona sandbox; agents never run on the host.
- Keys for Anchor and SurrealDB stay on Cloudflare: the sandbox reaches them through a token-gated gateway.
- Role-scoped memory enforced by SurrealDB: a crewmate cannot read or write another crewmate's notes.
- Evidence is read-only to workers; site content is treated as data, never instructions.
- Every merge passes review, a CI status and a merge guard; anything not observed is marked, never invented.
- An independent verifier checks the plan, each merged task and the final rebuild.

## Architecture
Browser (canvas + chat) → Cloudflare Workers (run API, gateway, verifier, captain relay) → Daytona run sandbox
(Firstmate, Codex crew, no-mistakes, git host, CI, preview, bridge). Outside the sandbox: Anchor, SurrealDB, Arize.

## Sponsor tools
- **Daytona:** one run sandbox per run hosts the whole agent system; preview URLs show the live rebuild;
  REST API driven from Cloudflare Workers; snapshot/fork for variant pods.
- **Anchor Browser:** evidence capture (full-page screenshots at desktop and mobile widths, rendered HTML)
  through the Cloudflare gateway, so the crew can request more evidence without holding the key.
- **SurrealDB Agent Memory:** role-scoped, time-aware memory with sources: per-role attenuated keys (first mate,
  crewmate, captain), durable per-site knowledge that later captures supersede, shared plan, private task notes.
- **Arize AX:** one trace per run (OTLP over HTTP from the Worker): chat turns, inspection, planning, every LLM call
  with token counts, every worker attempt with its review, and verifier verdicts.
- **AWS:** (if used for hosting/sandbox; otherwise remove)
- **ElevenLabs:** (not used in this build; remove unless added)

## Built with
Cloudflare Workers + Durable Objects, TypeScript, React, Daytona, Firstmate, OpenAI Codex (`gpt-6.1-sol`),
no-mistakes, treehouse, Gitea/tea, Anchor Browser, SurrealDB Agent Memory, Arize AX.

## Links
- Repo: https://github.com/AnalystTom/daytona_hack (must be public)
- Live preview of a rebuild: https://3000-0880ef74-6983-4480-860e-c89cc25ea4b8.daytonaproxy01.eu
