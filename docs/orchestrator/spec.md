# Reversy: agent system spec

How Reversy's agents plan, build, review and verify a rebuild.
Product behaviour is in [`../spec.md`](../spec.md).

## 1. Shape

```
Browser (Reversy UI)
   │  brief, answers, approvals, steering, overrides
   ▼
Cloudflare Workers app + API ──────► Verifier (Opus 5.5 high, API)
   │  ▲  events, reviews, previews       checks orchestrator outputs
   ▼  │
Daytona orchestrator sandbox
   ├─ Firstmate (orchestrator, never writes code)
   ├─ Workers 1–10 (one feature each, own branch)
   ├─ no-mistakes (review, tests, pull request per feature)
   └─ Forgejo (git host for the pull requests)
        │ VM fork (snapshot copy until enabled)
        ▼
   Variant pods (e.g. three landing-page alternatives), independent after the fork
```

## 2. Agents

| Agent | Model | Writes code | Job |
|---|---|---|---|
| Spec agent | GPT 6.1 high | No | Drafts the spec from the brief, asks the one round of questions, writes the scope for approval |
| Inspector | GPT 6.1 high | No | Drives an Anchor browser within the approved scope: screenshots, structure, components, styles and network calls; pauses for secure sign-in (an Anchor live session) on protected pages |
| Orchestrator (Firstmate) | GPT 6.1 high | No | Turns the findings into the visual plan, then gives each worker one approved feature with written instructions, sequences dependencies and merges approved work |
| Workers (1–10) | GPT 6.1 high | Yes | One feature at a time in an isolated branch, running commands freely inside the sandbox; submits a change plus screenshots of the pages it touched |
| Review (no-mistakes) | GPT 6.1 high | Fixes only | Runs on every worker submission: checks the change against its feature and the original spec, runs tests and opens the pull request |
| Verifier | Opus 5.5 high, API | No | Independent check of the orchestrator's outputs from outside the sandbox (section 5) |

## 3. Firstmate inside Daytona

- One Daytona sandbox per run holds a Firstmate home with the rebuild repository as its only project.
- Each approved feature becomes a Firstmate backlog item; each spawn is one worker in its own branch inside the same sandbox.
- Workers run on Firstmate's Codex runtime with model `gpt-6.1-sol` at high reasoning. Checked 16 October: the model is in Codex's catalog, marked API-supported, and answered a live call through a ChatGPT login; the API-key path is still to be tested in the sandbox.
- Delivery mode is no-mistakes, so every feature goes through review, tests and a pull request before merge.
- Pull requests live on a Forgejo (Gitea-compatible) server inside the sandbox, which Firstmate supports through the `tea` CLI.
- Merges happen automatically inside this throwaway repository; the user can steer or override at any time (section 6).
- A bridge in the sandbox streams Firstmate's status events, backlog changes and pull requests to the Cloudflare API, so the Build view's kanban (Queued, Building, In review, Merged) shows real state.
- The sandbox holds no source-site cookies or provider keys beyond what the agents need; generated code never receives them.

## 4. Feature lifecycle

1. The orchestrator writes the plan; the verifier checks it against the agreed scope before "Start build" becomes available.
2. After approval, Firstmate spawns a worker per ready feature, up to 10 at once.
3. The worker builds, then submits.
4. no-mistakes reviews and tests the change and opens a pull request. The UI shows it as a review card with the diff summary, original vs rebuild screenshots and the verdict.
5. On approval, Firstmate merges. The merge becomes the next build version on the timeline, and the verifier checks it against its feature.
6. On rejection, the worker revises once; if it fails again, the feature is marked failed with the real reason, and the user decides.
7. When all features are merged, the verifier checks the whole rebuild against the approved plan and posts the result in chat.

Acceptance tests come from the approved plan and are kept outside the workers' reach: a worker cannot edit the tests that judge it.

## 5. Verifier

- Called by the Cloudflare app through the Anthropic API (`claude-opus-5-5`, high effort), never from inside the sandbox, so it stays independent of the agents it checks.
- Input: the approved scope or plan, plus one orchestrator output (the plan, a merged feature, or the final rebuild with its screenshots).
- Output: pass or fail, with findings tied to plan items.
- A failure goes back to Firstmate as steering and shows in the UI.

## 6. Steering

- The user's chat messages reach Firstmate as captain input at any stage.
- The user can override a review or verifier verdict, or stop a worker.
- A change to the approved spec becomes a proposed change in chat; applying it creates a new spec revision that needs approval before new work starts.
- Every steer, override and approval is recorded with the run.

## 7. Variants

- A variant is a new pod with one agreed change, forked from an existing build. The landing page's three alternatives are three pods forked from the finished landing-page rebuild.
- With Daytona VM fork, a pod keeps its parent's files, Firstmate state and memory at fork time, then runs independently.
- VM fork is not yet enabled on our account. Until it is, a pod is a new sandbox from a snapshot of its parent: same files, no running memory, labelled "copy" rather than "fork".
- Changes in one pod never affect the other.

## 8. Records

SurrealDB stores runs, features, pull requests, reviews, verifier verdicts, steering, approvals and pods, linked to each other, and serves as Agent Memory for observations and decisions with their sources.
Arize holds one trace per run across inspection, planning, every feature, every review and every verification.

## 9. Open questions

1. Test `gpt-6.1-sol` through Codex with the OpenAI API key inside the Daytona sandbox.
2. Get VM fork enabled on our Daytona account, then switch pod B from copy to fork.
3. Check that no-mistakes works against Forgejo.
