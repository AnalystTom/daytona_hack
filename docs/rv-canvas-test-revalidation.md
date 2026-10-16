# Canvas test revalidation — 16 October 2026

Tested source: `3e65bf6178e4ce8dff8eb3fe54b885546e078e3a`.
Live HTTP origin: https://reversy.thomasmann2001.workers.dev.
The deployed API's commit was not independently established; HTTP results do not prove the target frontend's rendered behavior.

Firstmate steering 011 cancelled big-machine-1 and all new browser/app testing, including on the Mac. This revalidation used authenticated, read-only HTTP GETs against approved existing run `c962c14c-0628-422d-9f97-571894d69c17`. No runs or sandboxes were created, no synthetic records were injected, and no browser or server was launched.

## Current results

The prior 401 blocker is resolved with the explicitly supplied current operator credential. No product failure or failing focused test was reproduced, so no application or test changes were needed.

- Authenticated run read: **200**, phase `brief`, two chat entries, two evidence records, a spec, zero tasks.
- Authenticated event read: **200**, seven uniquely ordered events of types `chat`, `evidence`, `phase`, and `spec`.
- Incremental read after sequence 7: **200**, zero new events.
- Signed-out run and event reads: **401**.
- Authenticated unknown run read: **404**; signed-out unknown run read: **401**.
- Existing run preview read: **404**, no preview available.

Sanitized status/count/hash receipt, without credentials or response content:
`/Users/tom/.no-mistakes/evidence/01M532DK1EMJJ6QYNYD931X873/authenticated-http-revalidation.json`.

Focused verification passed: **41 tests in six files**, using:

```sh
npm test -- src/web/workspace/canvas.test.ts src/web/workspace/sessions.test.ts src/web/workspace/runClient.test.ts src/web/workspace/orchestrator.test.ts src/web/workspace/views.test.tsx src/web/build/BuildBoard.test.tsx
```

No full suite, lint, formatting, static analysis, deployment, push, PR, or CI phase was run by this Test step.

## Required Document/PR handoff

Carry these limits into the PR. These five scenarios remain **NOT LIVE-VERIFIED**; the HTTP checks above do not turn them into passed UI journeys.

| Scenario | HTTP evidence and remaining limit |
| --- | --- |
| Switch confirmed sessions and restore each run's chat/evidence | One approved existing run is readable with real chat/evidence. No second approved run was supplied, and browser testing was cancelled. UI switching and restoration remain unverified. |
| Switch sessions while successful run creation completes | Paid run creation is forbidden. No creation request was sent; browser testing was cancelled. The creation race remains unverified live. |
| Watch Build progression and scroll a long task log without panning | The real run has zero tasks and no task events. No paid build or synthetic events are allowed; browser testing was cancelled. Task progression and log scrolling remain unverified live. |
| Open an authenticated unknown run and recover without persisting it | Real authenticated GET returns 404; focused run-client tests cover the not-found result. Recovery rendering and session non-persistence were not rechecked in a browser because browser testing was cancelled. |
| Scroll Preview independently in a short desktop window | The approved run has no preview (GET returns 404), and paid builds are forbidden. Browser testing was cancelled; Preview layout and scrolling remain unverified live. |

Prior exact-head browser evidence predates cancellation and retains its original scope. The supplied driver manifest at `/Users/tom/Dev/firstmate/data/rv-canvas/final-3e65bf61/result.json` records 17 checks against the built target, including empty states, pan/zoom, access notices, session separation and mobile overflow. It does not cover the five scenarios above. Existing screenshots/video and cleanup receipts should remain attached by the outer Document/PR phase; this Test step did not recapture or extend them. The supplied cleanup receipt at `/Users/tom/Dev/firstmate/data/rv-canvas/test-revalidation-cleanup-verified.txt` records 24 exited revalidation PIDs and a closed test port. This HTTP-only step created no persistent processes or worktree build artifacts.
