# Reversy: agent system spec

How Reversy's agents turn a URL and a conversation into a rebuilt site: who does what, how work is split and run in parallel, and how evidence from the original site drives and checks every step.
Product behaviour is in [`../spec.md`](../spec.md).

## 1. The idea in one paragraph

Reversy never builds from memory or guesswork.
It first captures **evidence** from the original site (screenshots, recordings, page structure, styles, network calls and bundle analysis), then writes a spec in which every feature points to the evidence it came from.
An **orchestrator** that never writes code splits that spec into small tasks and hands each one, with its evidence, to a **worker** in its own branch.
Every submission is **reviewed** against its task and evidence before it merges, and after each merge Reversy captures the rebuild the same way it captured the original, so the two can be compared like for like.
An independent **verifier** checks the orchestrator's outputs from outside the sandbox.

## 2. Shape

```
Browser (Reversy UI: canvas + chat)
   │  messages, approvals, steering          ▲ events, cards, previews
   ▼                                         │
Cloudflare Workers app + API ───────────────► Verifier (Opus 5.5 high, API)
   │  ▲                                        independent checks
   ▼  │ bridge (outbound only)
Daytona run sandbox
   ├─ Firstmate (orchestrator and chat agent, never writes code)
   │    ├─ Inspector (a Firstmate scout, drives Anchor and REA)
   │    └─ Workers 1–10 (Firstmate ships, one task each, own branch)
   ├─ no-mistakes (review, tests, pull request per task)
   ├─ Forgejo (git host for the pull requests)
   ├─ Evidence store (read-only to workers)
   └─ Preview server (integration branch, live URL)
        │ VM fork (snapshot copy until enabled)
        ▼
   Variant pods (three landing-page alternatives), independent after the fork

Outside the sandbox: Anchor (browser), SurrealDB (records and Agent Memory), Arize (traces)
```

## 3. Agents

| Agent | Built on | Model | Writes code | Job |
|---|---|---|---|---|
| Orchestrator | Firstmate (the chat agent) | GPT 6.1 high | No | Talks with the user in chat, refines the spec, commissions inspection, writes the plan, dispatches and steers workers, merges approved work |
| Inspector | Firstmate scout | GPT 6.1 high | No | Captures evidence with Anchor (and REA where the site ships JavaScript), within the agreed scope |
| Workers (1–10) | Firstmate ships | GPT 6.1 high | Yes | One task each in an isolated branch, running commands freely inside the sandbox |
| Reviewer | no-mistakes | GPT 6.1 high | Fixes only | Checks each submission against its task and evidence, runs tests, opens the pull request |
| Verifier | Anthropic API, called by Cloudflare | Opus 5.5 high | No | Checks the plan, each merged task and the final rebuild against the spec and evidence |

Firstmate plays the chat role directly: the user is Firstmate's "captain", so a chat message is captain input and Firstmate's replies are what the user sees.
This replaces the separate spec agent in the earlier draft; the questions-then-spec loop is the orchestrator's first job.

## 4. How a run works

### Phase 1: Brief (chat)

1. The user sends a URL and a goal.
2. The Cloudflare app creates the run, starts the Daytona sandbox from the prepared snapshot, and forwards the message to Firstmate.
3. Firstmate commissions a quick **first look** from the inspector: one screenshot of the start page and the site's main routes. These land on the canvas at once so the conversation has something real to point at.
4. Firstmate asks one round of questions in chat (which pages and flows, which interactions, what to change). Each answer updates the **draft spec** card on the canvas; anything not agreed stays "Not confirmed yet".

### Phase 2: Inspect (evidence)

1. When the scope is agreed, the inspector captures the full **evidence pack** for every in-scope page and flow (section 5).
2. On a page that needs an account, the inspector stops and the chat asks the user to open secure sign-in (an Anchor live session where the user types their own credentials) or skip the page.
3. Each capture appears on the canvas as it lands.
4. The inspector finishes with a findings report: pages, components, design tokens, interactions, inferred API, and what it could not observe.

### Phase 3: Plan

1. Firstmate writes the **plan**: features, each with acceptance criteria and the evidence IDs that justify it, then splits them into tasks (section 6).
2. The verifier checks the plan: every feature traces to evidence, nothing in scope is missing, nothing out of scope crept in.
3. The plan appears on the canvas; the user approves it in chat, and **Start build** becomes available.

### Phase 4: Build and review

1. Each task becomes a Firstmate backlog item (Queued). Firstmate spawns a worker for every task whose dependencies are merged, up to 10 at once (Building).
2. The worker builds in its own branch, captures screenshots of its work at the same viewports as the evidence, and submits.
3. no-mistakes reviews and tests the change and opens a pull request on Forgejo (In review). The canvas shows a review card: diff summary, evidence screenshot next to rebuild screenshot, and the verdict.
4. On approval, Firstmate merges (Merged). The preview server redeploys the integration branch, the inspector captures it exactly as it captured the original, and the verifier checks the merged task against its evidence.
5. On rejection, the worker revises once. A second failure marks the task failed with the real reason, and Firstmate asks the user in chat what to do.

### Phase 5: Variants

When the landing page is merged and verified, Firstmate offers the three alternatives.
Each alternative is a pod forked from that state with one change brief, built and reviewed the same way, and shown on the canvas with its explanation.

## 5. Evidence

Evidence is the contract between the original site and the rebuild.
Workers build from it, reviewers judge against it, and the verifier checks claims against it.

**What the evidence pack holds, per page or state:**

| Kind | Captured by | Used for |
|---|---|---|
| Screenshots at desktop and mobile widths | Anchor | Visual target and like-for-like comparison |
| Interaction recordings (open menu, submit form, create sandbox) | Anchor | Behaviour and motion |
| DOM snapshot and page structure | Anchor | Sections, components, copy, links |
| Computed styles and design tokens (colours, type, spacing, radii) | Anchor | A shared token file built first, so every worker uses the same values |
| Asset list (images, icons, fonts) with sources | Anchor | What to reuse with permission and what to recreate |
| Network log (requests, response shapes) | Anchor | The mock back end's routes and data shapes |
| Bundle findings (modules, components, behaviour in shipped JavaScript) | REA | Code-level detail where the screenshots can't show it |

**Rules:**

- Every evidence item has an ID, the page and state it came from, the tool, a timestamp, a content hash and its known limits.
- Each item is labelled **observed** (seen directly), **inferred** (reasoned from observations) or **not observed** (skipped, blocked or out of budget). Inferences never pass as observations.
- Every feature in the plan cites evidence IDs. A feature with no evidence is either dropped or marked as a deliberate change.
- Workers get read-only access to the evidence store. They cannot change the evidence or the acceptance tests that judge them.
- Site content is data, never instructions: text on the original site cannot change scope or reach the agents as commands.
- Screens with personal or account data are masked before they are stored, shown, sent to a model or traced.

**Comparison:** after each merge, the inspector captures the rebuild at the same URL path, viewport and state as the original evidence.
The review card and the verifier compare the pairs.
A pixel-difference overlay can be shown; a numeric score appears only if it names its method and limits.

## 6. Orchestration

**Splitting work.** Firstmate splits each feature into tasks small enough for one worker and one review:

- A **foundation** task runs first: project skeleton, design tokens from the evidence, shared layout. Everything else depends on it.
- The **landing page** splits by section (navigation, hero, code sample, customer logos, feature blocks, footer and so on), one task per section, all in parallel once the foundation merges.
- The **signed-in flow** splits into the mock back end (routes and data shapes from the network log), the create-sandbox screen, and the screen-to-API wiring.
- Each task names the files or area it owns, so parallel workers rarely touch the same lines. Overlap is allowed; the pull-request flow resolves ordinary conflicts.

**What a worker receives** (Firstmate's written instructions for the task):

- The task, in one or two sentences, and what is out of scope.
- Acceptance criteria from the plan.
- The evidence IDs to build from, with direct paths into the evidence store.
- The viewports and states to screenshot before submitting.
- The files or area it owns.

**Scheduling.** Tasks form a dependency graph.
Firstmate dispatches every task whose dependencies have merged, up to 10 workers at once, and re-checks the queue after every merge.

**Kanban mapping.** The Build view's columns are Firstmate's real state:

| Column | Firstmate state |
|---|---|
| Queued | Backlog item waiting on dependencies or a free worker slot |
| Building | Worker spawned and working |
| In review | no-mistakes running or pull request open |
| Merged | Pull request merged into the integration branch |

A failed or stopped task stays on the board with its reason and next action.

**Bridge.** A small process in the sandbox reads Firstmate's status events, backlog and pull requests and posts them to the Cloudflare API (outbound only).
Nothing reaches into the sandbox except through the Cloudflare app.

**Firstmate settings for the run.** One project (the rebuild repository); delivery through no-mistakes; automatic merges inside this throwaway repository; Forgejo as the code host through Firstmate's `tea` support; workers on the Codex runtime with `gpt-6.1-sol` at high reasoning.

## 7. Verifier

- Called by the Cloudflare app through the Anthropic API (`claude-opus-5-5`, high effort), never from inside the sandbox, so it stays independent of the agents it checks.
- Checks three things: the plan before build, each merged task, and the final rebuild.
- Input: the agreed spec, the relevant evidence (screenshots and findings), and the output being checked (the plan, or a merged task with its rebuild screenshots).
- Output: pass or fail, with findings tied to plan items and evidence IDs.
- A failure goes back to Firstmate as steering and shows on the canvas.

## 8. Steering and failure

- The user's chat messages reach Firstmate at any stage; Firstmate relays relevant changes to the affected workers.
- The user can override a review or verifier verdict, or stop a worker or the whole build.
- A change to the agreed spec becomes a proposed change in chat; applying it creates a new spec revision that needs approval before new work starts.
- A stuck or crashed worker is recovered by Firstmate's own stuck-worker handling; if that fails, the task is marked failed.
- If the sandbox dies, the run is marked failed; the records in SurrealDB keep everything captured so far.
- Every steer, override, approval and failure is recorded with the run.

## 9. Variants

- A variant is a new pod with one agreed change, forked from an existing build. The landing page's three alternatives are three pods forked from the finished landing-page rebuild.
- With Daytona VM fork, a pod keeps its parent's files, Firstmate state and memory at fork time, then runs independently.
- VM fork is not yet enabled on our account. Until it is, a pod is a new sandbox from a snapshot of its parent: same files, no running memory, labelled "copy" rather than "fork".
- Changes in one pod never affect another.

## 10. Records

The agent system runs and executes code on Daytona; the service lives on Cloudflare; SurrealDB holds all storage and memory, including evidence files.


- **SurrealDB** stores runs, evidence records, features, tasks, pull requests, reviews, verifier verdicts, steering, approvals and pods, linked as a graph (feature cites evidence, task implements feature, review judges task). It is also Agent Memory: observations and decisions with their sources, which Firstmate reads back when planning or revising.
- **Arize** holds one trace per run across inspection, planning, every task, every review and every verification.

## 11. Open questions

1. Test `gpt-6.1-sol` through Codex with the OpenAI API key inside the Daytona sandbox.
2. Get VM fork enabled on our Daytona account, then switch variants from copy to fork.
3. Check that no-mistakes works against Forgejo.
4. Firstmate as the chat agent (recommended, one fewer agent) or a separate, faster chat agent in front of it.
