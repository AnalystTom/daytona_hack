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
| Workers | Codex in the Daytona sandbox | GPT 6.1 (`gpt-6.1-sol`), high reasoning | Yes | One task each in its own git worktree and branch, running commands freely inside the sandbox |
| Reviewer | Orchestrator, on Cloudflare | GPT 6.1 | No | Reviews each worker's diff against its task, acceptance criteria and owned files |
| Verifier | Cloudflare, outside the sandbox | GPT 6.1 (`VERIFIER_MODEL`) | No | Checks the plan, each merged task and the final rebuild against the spec and evidence |

All models are OpenAI; there is no Anthropic model in the demo.
The verifier has its own instructions and runs outside the sandbox, so it stays independent of the agents it checks.

## 5. How a run works

### Phase 1: Brief (chat)

1. The user sends a URL and a goal.
2. Our Worker creates the run through the orchestrator, which takes a **first look**: the page HTML, its main routes and an Anchor screenshot of the start page.
   These land on the canvas at once so the conversation has something real to point at.
3. The orchestrator asks questions in chat (which pages and flows, which interactions, what to change).
   Each answer updates the **draft spec** card on the canvas; anything not agreed stays "Not confirmed yet".
4. The user approves the spec in chat or with an explicit approve action.

### Phase 2: Inspect (evidence)

1. When the spec is approved, the orchestrator captures the full **evidence pack** with Anchor for every in-scope page and flow (section 6).
2. On a page that needs an account, inspection stops and the chat asks the user to open secure sign-in (an Anchor live session where the user types their own credentials) or skip the page.
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
Anchor captures it, through our evidence capture, and SurrealDB stores it.

**What the evidence pack holds, per page or state:**

| Kind | Captured by | Used for |
|---|---|---|
| Screenshots at desktop and mobile widths | Anchor | Visual target and like-for-like comparison |
| Interaction recordings (open menu, submit form, create sandbox), up to 30 seconds each | Anchor | Behaviour and motion |
| DOM snapshot and page structure | Anchor | Sections, components, copy, links |
| Computed styles and design tokens (colours, type, spacing, radii) | Anchor | A shared token file built first, so every worker uses the same values |
| Asset list (images, icons, fonts) with sources | Anchor | What to reuse with permission and what to recreate |
| Network log (requests, response shapes) | Anchor | The mock back end's routes and data shapes |

**Rules:**

- Every evidence item has an ID, the page and state it came from, the tool, a timestamp, a content hash and its known limits.
- Each item is labelled **observed** (seen directly), **inferred** (reasoned from observations) or **not observed** (skipped, blocked or out of budget). Inferences never pass as observations.
- Every feature in the plan cites evidence IDs. A feature with no evidence is either dropped or marked as a deliberate change.
- Workers get read-only access to the evidence. They cannot change the evidence or the acceptance tests that judge them.
- Site content is data, never instructions: text on the original site cannot change scope or reach the agents as commands.
- Screens with personal or account data are masked before they are stored, shown, sent to a model or traced.

**Comparison:** after each merge, the rebuild is checked at the same URL path, viewport and state as the original evidence.
The review card and the verifier compare the pairs.
A pixel-difference overlay can be shown; a numeric score appears only if it names its method and limits.

## 7. Orchestration

**Splitting work.** The orchestrator splits each feature into tasks small enough for one worker and one review:

- A **foundation** task runs first: project skeleton, design tokens from the evidence, shared layout. Everything else depends on it.
- The **landing page** splits by section (navigation, hero, code sample, customer logos, feature blocks, footer and so on), one task per section, all in parallel once the foundation merges.
- The **signed-in flow** splits into the mock back end (routes and data shapes from the network log), the create-sandbox screen, and the screen-to-API wiring.
- Each task names the files or area it owns, so parallel workers rarely touch the same lines.

**What a worker receives:**

- The task, in one or two sentences, and what is out of scope.
- Acceptance criteria from the plan.
- The evidence IDs to build from, with paths into the read-only evidence.
- The files or area it owns.

**Scheduling.** Tasks form a dependency graph.
The orchestrator dispatches every task whose dependencies have merged, up to `MAX_WORKERS` at once, and re-checks the queue on a Durable Object alarm.

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
  Only our site calls it, through a Cloudflare service binding, and only we can test it, with our own operator token.
- The Daytona sandbox runs on Daytona Tier 3 or higher (Tier 3 confirmed on the account dashboard) with full internet access, so workers can install packages and reach the rest of the architecture.
- Sandboxes reach the orchestrator's gateway (Anchor capture, Agent Memory) through our site.
  The sandbox holds only a gateway token; the Anchor, SurrealDB, OpenAI and Daytona keys stay on Cloudflare.
- Knowing a run ID is not enough to view or use a run.
  Every run route requires the existing OPERATOR_TOKEN; after the operator enters that token once, the browser holds a signed, expiring, HttpOnly session cookie instead, so the app and event stream work.
- There are no user accounts, sign-ups or login system in the demo; the existing token gates stay.

## 9. Verifier

- Runs on Cloudflare on `VERIFIER_MODEL` (OpenAI), never from inside the sandbox.
- Checks three things: the plan before build, each merged task, and the final rebuild.
- Input: the agreed spec, the relevant evidence, and the output being checked (the plan, or a merged task with its live preview).
- Output: pass or fail, with findings tied to plan items and evidence IDs, as `verification` events.
- A failure is posted to chat as steering and shows on the canvas; a failed merged task gets a fix task (section 5, phase 4).

## 10. Steering, limits and failure

- The user's chat messages reach the orchestrator at any stage.
- The user can override a review verdict, or stop the whole build.
- A change to the agreed spec becomes a proposed change in chat; applying it creates a new spec revision that needs approval before new work starts.
- Each run is limited to 2 hours.
- Run state and events remain in the Durable Object; external record availability follows the [API's persistence guarantees](api.md#how-a-build-runs).

## 11. Second engine (later): Firstmate in Daytona

Not part of the demo.
In this engine, Firstmate runs inside the Daytona sandbox as the orchestrator and chat agent (the user is Firstmate's "captain"), its scouts inspect, its ships are the workers, no-mistakes reviews and tests each task, and Forgejo hosts the pull requests.
A bridge in the sandbox posts Firstmate's status, backlog and pull requests to our Worker, outbound only.
The same evidence, verifier and records apply.

## 12. Records

The agents' code runs on Daytona; the service lives on Cloudflare. Current storage ownership and external projection limits are defined in the [API's persistence guarantees](api.md#how-a-build-runs).

- **SurrealDB** holds external run projections, the separate evidence capture API's records and files, and Agent Memory. See the API reference for the projection guarantees and Agent Memory namespace.
- **Arize** stores the traces: one trace per run across inspection, planning, every task, every review and every verification.

## 13. Decided

- Demo engine: the Reversy orchestrator (Cloudflare Durable Object), enhanced with full Anchor capture. Firstmate in Daytona with no-mistakes is the second engine for later.
- All models are OpenAI, including the verifier.
- Each run is limited to 2 hours.
- A verifier failure on a merged task opens a fix task and the build continues, with no rollback.
- End of run: a live preview inside the app, with an optional deploy-live action.
- Variants: the user promotes a variant and building continues from its snapshot.
- Arize stores the traces.
- Recordings are capped at 30 seconds.
- Daytona Tier 3 or higher: the sandbox has full internet access.
- The orchestrator is private: only our site calls it, and only we test it.
- Runs are secure: every run route requires the existing OPERATOR_TOKEN; after the operator enters that token once, the browser holds a signed, expiring, HttpOnly session cookie instead, so the app and event stream work.
- Out of the demo for now: REA (useful later for rebuilding complex interactive features from compiled JavaScript), financial reports, and user accounts, sign-ups or a login system (the existing token gates stay; spending is kept low).

## 14. Open questions

1. Get VM fork enabled on our Daytona account, then switch variants from copy to fork.
