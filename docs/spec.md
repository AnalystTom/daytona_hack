# Reversy: product spec

Reversy ("Take it apart. Make it yours.") is a reverse-engineering assistant.
The user gives a site and a goal in chat, refines the scope in conversation, and watches agents on Daytona inspect the site and rebuild it on a shared canvas.
Daytona HackSprint, New York, 16 October 2026.

This file and [`orchestrator/spec.md`](orchestrator/spec.md) sit alongside *Reversy implementation specification, Revision 2* (the detailed handoff: routes, schemas, limits, security and acceptance tests).
Where this repo records a decision made after Revision 2, it wins; the decisions are listed in section 7.
Design source: the team's Excalidraw board ("Reversy: minimal canvas workspace"), captured in `docs/screens/`.
That board revision replaces the earlier confirmation form, six-stage stepper and Compare concepts.

## 1. One workspace: canvas on the left, chat on the right

The app shell is minimal: a canvas plus a right-hand chat.
There is no left navigation sidebar, giant title, numbered stepper, decorative mascot scene or separate Compare screen.
The header holds the Reversy name, two canvas views (**Spec** and **Build**) and a **Start build** button.

**Chat is how the user and Reversy talk.**
The user gives a URL and a goal, then refines the scope in conversation; questions and follow-ups stay in the chat panel, not in a form.
Answers update the living spec on the canvas.
The chat stays visible while Reversy inspects, plans and builds, and is where the user steers and clarifies scope.

**The canvas holds the work.**
Spec and Build show different objects in the same environment.

## 2. Spec view: refine the brief in chat, build the spec on the canvas

![Spec view: draft spec, target screenshot and video evidence beside the chat](screens/workspace-minimal-canvas.png)

The canvas is the specification and evidence surface:

- **Draft spec** card: the target URL, pages and flows, and open questions. Anything not yet agreed is shown as "Not confirmed yet".
- **Target screenshot** cards: real screenshots captured from the site.
- **Video evidence** cards: real recordings of interactions, or "No recording yet".
- Each piece of evidence links to its page or flow.

The board's raster is a layout reference only; the live canvas shows the original captured artifacts.
When a page needs an account, an inline state asks the user to open secure sign-in or skip that page.

## 3. Build view: build and review on the same canvas

![Build view: kanban with Queued, Building, In review and Merged](screens/workspace-build-review.png)

- **Start build** needs an approved, saved spec. Until then the board reads "No build started: tasks appear after the spec is approved."
- The kanban has four columns, **Queued**, **Building**, **In review** and **Merged**, driven by real task events. **Stop build** halts the work.
- Selecting a task opens its log, preview and review on the canvas.
- A submitted task links to its real diff and visual evidence. The reviewer's verdict and reason appear only once recorded.
- Failed or rejected work stays visible with its next action.
- Sign-in, reconnect and cleanup appear as inline states.
- The draft spec card stays on the canvas below the board.
- No invented tasks, verdicts, scores or timer-driven progress.

**Steering:** the user can message the orchestrator at any time and override a review verdict.
A message that changes the approved spec becomes a proposed change; applying it creates a new spec revision for approval rather than editing a running build.

## 4. Scope for this version

Demo target: `https://www.daytona.io/` (Daytona has agreed).
Two pieces of work run in parallel, each split into tasks on the kanban:

1. **Landing page, in detail.** A faithful rebuild of the daytona.io landing page, plus three alternative versions of it. Each alternative comes with a short explanation, shown on the canvas, of how it changes the page and the visitor's path through it.
2. **One signed-in flow:** create a sandbox, with a mock back end that has the same routes and response shapes as the original. v2 rebuilds the back end properly.

The three alternatives are pods forked from the finished landing-page rebuild.
Daytona VM fork is the target; until it is enabled on our account, pods are copies from a snapshot and labelled as copies.

## 5. Mascot

![Chainsaw beaver mascot](screens/mascot-chainsaw-beaver.png)

The mascot is the **chainsaw beaver**: a playful teardown metaphor with a clear silhouette (safety goggles, orange overalls, pistachio tail, chainsaw cutting a browser window apart).
It stays quiet in the workspace: a small chat avatar or a brief state illustration, never taking over the working canvas.
The current image is concept art, not a final brand asset.
The other four options on the board (chainsaw robot, spanner raccoon, toolkit octopus, clockwork beetle) are not used.

## 6. Look and feel

All frontend work follows `.claude/skills/frontend-design/SKILL.md`; where the board and Revision 2 set the direction, they win.

- Palette: Aubergine `#39253F` (text, key controls), Pistachio `#C4DB9B` (gentle highlights, active view), Persimmon `#EB7957` (calls to action, active work), Parchment `#F6F2E9` (background). Status always pairs colour with text and an icon, and error red must differ from persimmon.
- Type: Fraunces for headings, Manrope for body and controls, a readable monospace for logs.
- Canvas: soft dotted background, white rounded cards with thin borders, restrained shadows.
- Controls are real HTML, and every state comes from real data.

## 7. Platform and decisions

| Piece | Use |
|---|---|
| Cloudflare Workers | Hosts the web app and its API |
| Daytona | Runs every agent; preview URLs; VM fork for variants once enabled |
| Anchor | Essential: the browser for inspection (screenshots, recordings, interactions) and for secure sign-in, where the user signs in themselves |
| SurrealDB | Main data store (runs, tasks, reviews, verdicts, canvas) and Agent Memory for observations and decisions with their sources |
| Arize | One trace per run across inspection, planning, building, review and verification |
| GPT 6.1 high via API | Spec agent, inspector, orchestrator, workers and review |
| Opus 5.5 high via API | Verifier that checks the orchestrator's outputs |

Decided since Revision 2, which lists these as open or says otherwise:

- First site: daytona.io, with Daytona's permission.
- Repository: new, `AnalystTom/daytona_hack`.
- Runtime models: GPT 6.1 high for the agents, Opus 5.5 high for the verifier.
- Hosting: Cloudflare Workers.
- Build engine: Firstmate orchestrating workers in a Daytona sandbox, with no-mistakes review. Workers run commands inside their sandbox, replacing Revision 2's no-shell agent loop.
- Scope: landing page plus one flow, built in parallel, with three landing-page alternatives. This replaces Revision 2's limit of two pods.
- SurrealDB is the main store as well as Agent Memory, not an optional extra.
- UI: the minimal canvas workspace (chat on the right; Spec and Build views; kanban) replaces Revision 2's six screens, stepper, confirmation form and Compare screen.
- Mascot: the chainsaw beaver replaces the cream robot.

Still open: the hard spend cap, and which sponsor accounts actually work.
