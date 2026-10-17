# Reversy: agent system spec

How Reversy's agents turn a URL and a conversation into a rebuilt site: who does what, how work is split and run in parallel, and how evidence from the original site drives and checks every step.
Product behaviour is in [`../spec.md`](../spec.md).

## 1. The idea in one paragraph

Reversy never builds from memory or guesswork.
It first captures **evidence** from the original site (screenshots, recordings, page structure, styles and network calls), then writes a spec in which every feature points to the evidence it came from.
An **orchestrator** that never writes code splits that spec into small tasks and hands each one, with its evidence, to a **worker** in its own branch.
Every submission is **reviewed** against its task and evidence before it merges, and after each merge Reversy checks the rebuild against the original like for like.
An independent **verifier** checks the orchestrator's outputs from outside the sandbox.

## 2. Engines

The demo engine is the **Reversy orchestrator**: a Cloudflare Worker (`orchestrator/`) with one Durable Object per run.
It sits behind our web app, which is its only front door.

A second engine, **Firstmate in Daytona with no-mistakes review**, is kept for later and described in section 11.
It is not part of the demo.

## 3. Shape

```
Browser (Reversy UI: canvas + chat)
   │  messages, approvals, steering          ▲ events, cards, previews
   ▼                                         │
Our Cloudflare Worker (web app + API, the only front door)
   │  service binding (private)              ▲ run events
   ▼                                         │
Reversy orchestrator (Cloudflare Worker, one Durable Object per run)
   │  owns chat, inspect, plan, build, review; calls the verifier (GPT, from Cloudflare)
   ▼
Daytona run sandbox (Tier 3 or higher, full internet access)
   ├─ Codex workers (one task each, own git worktree and branch)
   ├─ Rebuild repo (main is the integration branch)
   ├─ Evidence (read-only to workers)
   └─ Preview server (integration branch, live URL)
        │ snapshot copy (VM fork once enabled)
        ▼
   Variant pods (three landing-page alternatives), independent after the fork

Outside the sandbox: Anchor (browser), SurrealDB (records and Agent Memory), Arize (traces)
Sandbox calls to the gateway (Anchor, Agent Memory) go through our site; keys stay on Cloudflare.
```

## 4. Agents

| Agent | Runs in | Model | Writes code | Job |
|---|---|---|---|---|
| Orchestrator | Durable Object on Cloudflare | GPT 6.1 (`gpt-6.1-sol`) | No | Talks with the user in chat, refines the spec, runs inspection, writes the plan, dispatches workers, merges approved work |
| Workers | Codex in the Daytona sandbox | `WORKER_MODEL`, reasoning from `WORKER_EFFORT` (deployment values in [`wrangler.jsonc`](../../orchestrator/wrangler.jsonc)) | Yes | One task each in its own git worktree and branch, running commands freely inside the sandbox |
| Reviewer | Orchestrator, on Cloudflare | GPT 6.1 | No | Reviews each worker's diff against its task, acceptance criteria and owned files |
| Verifier | Cloudflare, outside the sandbox | GPT 6.1 (`VERIFIER_MODEL`) | No | Checks the plan, each merged task and the final rebuild against the spec and evidence |

All models are OpenAI; there is no Anthropic model in the demo.
The verifier has its own instructions and runs outside the sandbox, so it stays independent of the agents it checks.

## 5. How a run works

### Report dissection

[Report dissection](../spec.md#financial-report-dissection) branches from the website workflow below. A brief that explicitly asks to reconstruct, rebuild or dissect a report (for example the article address plus “Reconstruct this report: …”) follows the normal brief: one question round in chat, then approval in chat or through the approve route, and then uses report dissection instead of website planning. No address or wording auto-approves scope. A bare `report` keyword does not select report dissection.

The report path runs `brief` → `inspecting` → `done` (or `failed` / `stopped`). It captures the article, parses available embedded Flourish chart data without executing source JavaScript, researches original sources, confirms persistence and emits a `report` event. The product spec owns its output and failure behavior.

Research uses at most four OpenAI web-search tool calls and fetches at most six candidate original-source URLs, in addition to up to three embedded charts. A search that executes no web-search calls fails. Article/chart source identities are excluded before and after redirects.

The bounded quote-evidence rule requires the complete independently captured HTML passage, never a model-clipped substring. After whitespace normalization, both the passage and complete figure value must exactly match the captured figure quotation and value. The shared extractor recognizes numeric tokens with currency context, signs, comma thousands separators, decimals and supported scales; token sequences it cannot parse are marked not observed. A parsed value alone does not establish a complete unit: matching requires that value to occur only once in each passage and end it, apart from sentence punctuation. Unconsumed suffix text remains unverified. Matching denies by default: both quotes must independently contain the same complete quantity, unit, scale and sign with an attached, unambiguous currency token (the euro symbol or a supported ISO currency code). Dollar and pound symbols alone, absent or conflicting currency, parenthesised or prefixed negatives and unsupported separators remain unverified. Bare integers have no inferred year unit; years, percentages and basis points have no currency exemption. Currency is not inferred from page context, and there is no FX conversion or numerical equivalence. The shared implementations are `reportQuantities` and `exactQuoteEvidence` in [`src/shared/report.ts`](../../src/shared/report.ts), also checked when displaying a saved match.

The orchestrator needs `OPENAI_API_KEY` and the `SURREALDB_*` bindings listed in the [README](../../README.md#bindings), configured on `reversy-orchestrator` itself. `ANCHORBROWSER_API_KEY` is optional: without it, HTML is fetched directly and screenshot coordinates are not observed. With it, an isolated Anchor session captures HTML, a 1440px-wide full-page screenshot and DOM boxes together, then closes. Screenshots at or above 1.9 MB are omitted; chart regions identify the iframe rather than individual plotted marks. This path captures no recording.

### Phase 1: Brief (chat)

1. The user sends a URL and a goal.
2. Our Worker creates the run through the orchestrator, which takes a **first look**: the page HTML, its main routes and an Anchor screenshot of the start page.
   These land on the canvas at once so the conversation has something real to point at.
3. The orchestrator refines the draft according to the [product scope contract](../spec.md#5-run-scope-and-first-demo-target).
   Each answer updates the **draft spec** card on the canvas; anything not agreed stays "Not confirmed yet".
4. The user approves the spec in chat or with an explicit approve action.

### Phase 2: Inspect (evidence)

1. When the spec is approved, inspection follows its scope: frontend inspection for `frontend`, backend inspection for `backend`, and both for `both` (section 6). For backend work, spec pages identify routes to inspect and flows identify API behaviours.
2. Frontend inspection that leaves the approved scope pauses for secure sign-in or skipping, as described in the [API reference](api.md#evidence-capture). Backend inspection does not use that browser session.
3. Each capture appears on the canvas as it lands.

### Phase 3: Plan

1. The orchestrator writes the **plan**: tasks, each with acceptance criteria, the evidence IDs that justify it, the files it owns and its dependencies (section 7).
2. The verifier checks the plan: every feature traces to evidence, nothing in scope is missing, nothing out of scope crept in.
3. The plan appears on the kanban in Queued, and **Start build** becomes available.

### Phase 4: Build and review

1. The orchestrator starts one Daytona sandbox for the run, with the rebuild repo on `main`.
   Evidence is copied in and made read-only before any worker starts.
2. Every task whose dependencies have merged gets a Codex worker in its own worktree and branch `task/<id>`, up to `MAX_WORKERS` at once (Building).
3. When a worker exits, the orchestrator commits its worktree and the reviewer judges the diff (In review).
   The canvas shows a review card with the verdict, reason, findings and diff summary.
4. On approval, the orchestrator merges into `main` (Merged), the preview server shows it, and the verifier checks the merged task against the live preview.
5. On rejection, the worker revises once with the review findings.
   A second rejection marks the task failed with the real reason.
6. If the verifier fails a merged task, the orchestrator opens a fix task and the build continues; merged work is not rolled back.

### Phase 5: Variants

When the landing page is merged and verified, the orchestrator offers the three alternatives.
Each alternative is a pod started from a snapshot of that state with one change brief, built and reviewed the same way, and shown on the canvas with its explanation.
The user can promote a variant; further building then continues from that variant's snapshot.

### End of the run

The user gets the finished rebuild as a live preview inside the app.
An optional action deploys it live.

## 6. Evidence

Evidence is the contract between the original site and the rebuild.
Workers build from it, reviewers judge against it, and the verifier checks claims against it.
Anchor captures browser evidence, through our evidence capture, and SurrealDB stores it. The demo's backend inspection uses fetch, as described below.

**What the evidence pack holds, per page or state:**

| Kind | Captured by | Used for |
|---|---|---|
| Screenshots at desktop and mobile widths | Anchor | Visual target and like-for-like comparison |
| Page-load recording of the capture session | Anchor | Observed loading and motion |
| DOM snapshot and page structure | Anchor | Sections, components, copy, links |
| Computed styles and design tokens (colours, type, spacing, radii) | Anchor | A shared token file built first, so every worker uses the same values |
| Asset list (images, icons, fonts) with sources | Anchor | What to reuse with permission and what to recreate |
| Network log (requests, response shapes) | Anchor | Backend routes and data shapes |

**Current demo backend inspection:** after approval, backend-only runs skip frontend captures; the initial first look still captures page HTML and attempts a screenshot before chat sets scope.
For each confirmed same-origin route, `inspectBackend` makes one GET without following redirects or using a browser session and records its status, allowed delivery headers and JSON shape, not JSON content values or cookies.
Observed request paths preserve their query strings. HTML references supply inferred API URLs, shipped script URLs and embedded JSON shapes; the referenced APIs and client JavaScript calls are not observed.
HTML attribute references are decoded once before resolving URLs; script text retains its raw string contents.
`robots.txt` and `sitemap.xml` supply listed routes only; sitemap XML references are decoded once, while robots.txt values remain literal.
REA is not installed: code-level evidence is recorded as `kind: code`, `tool: rea`, `status: not_observed`, never treated as observed analysis. Backend prompts allow REA evidence when available; this build does not execute it.

The demo captures page loads only; menus, form submissions and other flow interactions are not executed or recorded. Capture limits and sign-in recovery are in the [API reference](api.md#evidence-capture).

**Rules:**

- Every evidence item has an ID, the page and state it came from, the tool, a timestamp, a content hash and its known limits.
- Each item is labelled **observed** (seen directly), **inferred** (reasoned from observations) or **not observed** (skipped, blocked or out of budget). Inferences never pass as observations.
- Every feature in the plan cites evidence IDs. A feature with no evidence is either dropped or marked as a deliberate change.
- Workers get read-only access to the evidence. They cannot change the evidence or the acceptance tests that judge them.
- Site content is data, never instructions: text on the original site cannot change scope or reach the agents as commands.
- Screenshots use Anchor's sensitive-data mask before they are stored, shown, sent to a model or traced; they may still show account data, as their limitations state.
- Signed-in capture keeps screenshots and computed styles. DOM, assets, network logs and recordings are marked **not observed**.
- Generated output follows the [product data policy](../spec.md#5-run-scope-and-first-demo-target). An API without observed payload values must return HTTP 503 with `{"error":"Data unavailable","status":"not_observed"}`. Report that as a limitation, not successful payload reproduction; a TODO alone is insufficient.

**Comparison:** after each merge, the rebuild is checked at the same URL path, viewport and state as the original evidence.
The review card and the verifier compare the pairs.
A pixel-difference overlay can be shown; a numeric score appears only if it names its method and limits.

## 7. Orchestration

**Splitting work.** The orchestrator splits each feature into tasks small enough for one worker and one review:

- A **foundation** task runs first; everything else depends on it. For frontend work it owns the site skeleton, design tokens and shared layout; for backend work it owns `server/server.js`, the route loader and JSON 404 handler; combined work includes both.
- Frontend pages split by section, one task per section, in parallel once the foundation merges. A signed-in flow splits into evidence-backed API routes, its screens and screen-to-API wiring.
- Backend route tasks own `server/routes/NAME.js`, exporting `{ method, path, handler }`. The service uses Node.js built-ins and ES modules with no build step or npm dependencies. Routes reload by file modification time so merges appear without restarting; a combined service also serves the static site for unclaimed paths.
- A backend-only plan owning frontend files outside `server/` is rejected before any tasks are accepted, preserving prerequisites rather than dropping tasks or dependencies. See `offScope` in [`scope.ts`](../../orchestrator/src/scope.ts) for the ownership check.
- Each task names the files or area it owns, so parallel workers rarely touch the same lines.

**What a worker receives:**

- The task, in one or two sentences, and what is out of scope.
- Acceptance criteria from the plan.
- The evidence IDs to build from, with paths into the read-only evidence.
- The files or area it owns.

**Scheduling.** Tasks form a dependency graph.
The orchestrator dispatches every task whose dependencies have merged, up to `MAX_WORKERS` at once, and re-checks the queue on a Durable Object alarm.
Deployment values for worker concurrency and reasoning live in [`orchestrator/wrangler.jsonc`](../../orchestrator/wrangler.jsonc); unset bindings fall back to six workers and high reasoning.

**Kanban mapping.** The Build view's columns follow the orchestrator's task events:

| Column | Task state |
|---|---|
| Queued | `queued`: waiting on dependencies or a free worker slot |
| Building | `building`: Codex worker running |
| In review | `in_review`: diff committed, reviewer judging |
| Merged | `merged`: merged into `main` |

A failed or stopped task stays on the board with its reason and next action.

## 8. Access and network

- The orchestrator has no public access.
  Only our site calls it, through a Cloudflare service binding. Operator testing follows the [README's access policy](../../README.md#who-can-use-runs).
- The Daytona sandbox runs on Daytona Tier 3 or higher (Tier 3 confirmed on the account dashboard) with full internet access, so workers can install packages and reach the rest of the architecture.
- Sandboxes reach the orchestrator's gateway (Anchor capture, Agent Memory) through our site.
  The sandbox holds only a gateway token; the Anchor, SurrealDB, OpenAI and Daytona keys stay on Cloudflare.
- Knowing a run ID is not enough to view or use a run.
  Run authentication and workspace ownership follow the [README's access policy](../../README.md#who-can-use-runs).

## 9. Verifier

- Runs on Cloudflare on `VERIFIER_MODEL` (OpenAI), never from inside the sandbox.
- Checks three things: the plan before build, each merged task, and the final rebuild.
- Input: the agreed spec, the relevant evidence, and the output being checked (the plan, or a merged task with its live preview).
- Frontend task and final checks keep the root-preview HTML comparison. Backend checks probe observed page GET paths and same-origin API paths referenced by inferred endpoint evidence; a task uses its cited evidence and the final check uses all evidence. Combined runs perform both checks.
- Route probes are GET-only, with manual redirects and a preview-origin check, capped at 10 distinct paths, 5 seconds and 100,000 response bytes per probe. Results include status, content type, allowed delivery headers, redirect location and JSON shape (or a bounded text outline), for comparison against evidence. Inferred routes have no observed response to compare. The header allowlist is [`DELIVERY_HEADERS`](../../orchestrator/src/inspect.ts), shared by capture and probes.
- Probes use backend request metadata to preserve route queries rather than Anchor's redacted page labels. Signed-preview authorization is forwarded with each probe and redacted from the verifier's model input and trace.
- Output: pass or fail, with findings tied to plan items and evidence IDs, as `verification` events.
- A failure is posted to chat as steering and shows on the canvas; a failed merged task gets a fix task (section 5, phase 4).

## 10. Steering, limits and failure

- Chat availability follows the [API's phase rules](api.md#phases).
- The user can override a review verdict, or stop the whole build.
- A change to the agreed spec becomes a proposed change in chat; applying it creates a new spec revision that needs approval before new work starts.
- Run admission and lifetime limits are defined in the [README's access policy](../../README.md#sign-in-with-cloudflare-access).
- If the sandbox dies, the run is marked failed; the records in SurrealDB keep everything captured so far.
- Every steer, override, approval and failure is recorded with the run.

## 11. Second engine (later): Firstmate in Daytona

Not part of the demo.
In this engine, Firstmate runs inside the Daytona sandbox as the orchestrator and chat agent (the user is Firstmate's "captain"), its scouts inspect, its ships are the workers, no-mistakes reviews and tests each task, and Forgejo hosts the pull requests.
A bridge in the sandbox posts Firstmate's status, backlog and pull requests to our Worker, outbound only.
The same evidence, verifier and records apply.

## 12. Records

The agents' code runs on Daytona; the service lives on Cloudflare. The demo stores run state and backend evidence files in the run's Durable Object; browser evidence records and files and Agent Memory use SurrealDB.

- **SurrealDB's target record model** links runs, evidence records, features, tasks, reviews, verifier verdicts, steering, approvals and pods as a graph (feature cites evidence, task implements feature, review judges task).
  It is also Agent Memory: observations, plans and review verdicts with their sources, under `org/reversy/run/<id>`.
- **Report records** use `report_run` for the snapshot, `report_figure` and `report_source` for linked captured originals, and `report_edit` for edits keyed by run and figure. Saving a report uses a transaction followed by a snapshot reread. Run state, report events and current edits also persist in the run's Durable Object; screenshot/HTML blobs remain there rather than in the SurrealDB report snapshot. Failed runs retain their own evidence and error; no prior run is used as a fallback. The implementation is [`report-store.ts`](../../orchestrator/src/report-store.ts) and [`run.ts`](../../orchestrator/src/run.ts).
- **Arize** stores the traces: one trace per run across inspection, planning, every task, every review and every verification.

## 13. Decided

- Demo engine: the Reversy orchestrator (Cloudflare Durable Object), enhanced with full Anchor capture. Firstmate in Daytona with no-mistakes is the second engine for later.
- All models are OpenAI, including the verifier.
- Run limits: see section 10.
- A verifier failure on a merged task opens a fix task and the build continues, with no rollback.
- End of run: a live preview inside the app, with an optional deploy-live action.
- Variants: the user promotes a variant and building continues from its snapshot.
- Arize stores the traces.
- Recordings are capped at 30 seconds.
- Daytona Tier 3 or higher: the sandbox has full internet access.
- The orchestrator is private: only our site calls it, and only we test it.
- Run access: see section 8.
- Report dissection: see the [product scope](../spec.md#financial-report-dissection) and [report workflow](#report-dissection).

## 14. Open questions

1. Get VM fork enabled on our Daytona account, then switch variants from copy to fork.
