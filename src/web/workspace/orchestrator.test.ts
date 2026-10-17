import { describe, expect, it } from "vitest";
import { deriveBoard } from "../build/board";
import { chatEntries, type OrchestratorEvent, runView } from "./orchestrator";

// Events in the shapes docs/orchestrator/api.md documents, in the order a run emits them.
let seq = 0;
const ev = (type: string, data: unknown): OrchestratorEvent => ({
  seq: ++seq,
  ts: `2026-10-16T12:00:${String(seq).padStart(2, "0")}.000Z`,
  type,
  data,
});

const task = (id: string, status: string, extra: object = {}) => ({
  id,
  title: `Task ${id}`,
  brief: "",
  outOfScope: "",
  acceptance: [],
  evidence: [],
  owns: [],
  dependsOn: [],
  status,
  attempts: 1,
  branch: `task/${id}`,
  ...extra,
});

const spec = {
  url: "https://www.daytona.io/",
  goal: "Rebuild the landing page",
  pages: [
    { path: "/", confirmed: true, notes: "hero and pricing" },
    { path: "/docs", confirmed: false },
  ],
  flows: [{ name: "Create a sandbox", confirmed: false, notes: "" }],
  openQuestions: ["Keep the dark theme?"],
  approved: false,
  revision: 0,
};

const events = [
  ev("phase", { phase: "brief" }),
  ev("chat", { role: "user", text: "https://www.daytona.io/\ncopy it" }),
  ev("evidence", {
    id: "ev_001",
    page: "/",
    kind: "screenshot",
    tool: "anchor",
    status: "observed",
    capturedAt: "2026-10-16T12:00:00.000Z",
    hash: "sha256:abc",
    limits: "Desktop viewport only",
    url: "/runs/r1/evidence/ev_001",
  }),
  ev("evidence", {
    id: "ev_002",
    page: "/",
    kind: "dom",
    tool: "anchor",
    status: "observed",
    capturedAt: "2026-10-16T12:00:00.000Z",
    hash: "sha256:def",
    limits: "",
    summary: "dom of /",
  }),
  ev("evidence", {
    id: "ev_003",
    page: "session: /",
    kind: "recording",
    tool: "anchor",
    status: "observed",
    capturedAt: "2026-10-16T12:00:00.000Z",
    hash: "sha256:fed",
    limits: "First 30 seconds",
    url: "/runs/r1/evidence/ev_003",
  }),
  ev("spec", spec),
  ev("chat", { role: "assistant", text: "Which pages should we include?" }),
  ev("spec", { ...spec, approved: true, revision: 1 }),
  ev("phase", { phase: "planned" }),
  ev("plan", { tasks: [task("t01", "queued"), task("t02", "queued")] }),
  ev("phase", { phase: "building" }),
  ev("preview", { sandboxId: "sb" }),
  ev("task", task("t01", "building")),
  ev("task", task("t01", "in_review")),
  ev("review", {
    taskId: "t01",
    verdict: "approve",
    reason: "All criteria met",
    findings: [],
    diffStat: "index.html | 12 +",
  }),
  ev("task", task("t01", "merged")),
  ev("preview", { mergedTask: "t01" }),
  ev("verification", {
    target: "task",
    taskId: "t01",
    pass: true,
    summary: "Hero matches",
    findings: [],
  }),
  ev("task", task("t02", "building")),
  ev("task", task("t02", "in_review")),
  ev("review", {
    taskId: "t02",
    verdict: "reject",
    reason: "Pricing cards missing",
    findings: ["No cards"],
    diffStat: "",
  }),
  ev(
    "task",
    task("t02", "failed", {
      attempts: 2,
      failure: "Pricing cards missing",
      nextAction: "Ask the user in chat: retry, override, or drop",
    }),
  ),
  ev("error", { message: "Daytona exec timed out" }),
  ev("chat", { role: "assistant", text: "Task t02 failed review twice." }),
];

describe("chatEntries", () => {
  it("turns assistant replies and errors into chat lines, skipping the user's own", () => {
    expect(chatEntries(events)).toEqual([
      { kind: "agent", id: "run-7", text: "Which pages should we include?" },
      {
        kind: "notice",
        id: "run-23",
        error: "run_error",
        detail: "Daytona exec timed out",
      },
      { kind: "agent", id: "run-24", text: "Task t02 failed review twice." },
    ]);
  });

  it("brings back the user's messages for a reopened session", () => {
    const lines = chatEntries(events, { withUser: true });
    expect(lines.filter((line) => line.kind === "user")).not.toHaveLength(0);
    expect(lines.find((line) => line.kind === "user")).toMatchObject({
      delivery: "sent",
    });
    expect(lines.filter((line) => line.kind !== "user")).toEqual(
      chatEntries(events),
    );
  });
});

describe("runView", () => {
  const view = runView("r1", events);

  it("keeps the latest spec as the draft spec card", () => {
    expect(view.draftSpec).toEqual({
      url: "https://www.daytona.io/",
      pagesAndFlows: [
        "/: hero and pricing",
        "/docs (not confirmed yet)",
        "Create a sandbox (not confirmed yet)",
      ],
      openQuestions: ["Keep the dark theme?"],
      status: "approved",
    });
  });

  it("shows screenshots and recordings through the run API and leaves other evidence out", () => {
    expect(view.evidence).toEqual([
      {
        id: "ev_001",
        kind: "screenshot",
        label: "observed",
        pageOrState: "/",
        tool: "anchor",
        capturedAt: "2026-10-16T12:00:00.000Z",
        contentHash: "sha256:abc",
        limitations: ["Desktop viewport only"],
        src: "/api/v1/runs/r1/evidence/ev_001",
      },
      {
        id: "ev_003",
        kind: "recording",
        label: "observed",
        pageOrState: "session: /",
        tool: "anchor",
        capturedAt: "2026-10-16T12:00:00.000Z",
        contentHash: "sha256:fed",
        limitations: ["First 30 seconds"],
        src: "/api/v1/runs/r1/evidence/ev_003",
      },
    ]);
  });

  it("shows the entered URL's redirect and a card for a screenshot that was not observed", () => {
    const redirected = runView("r2", [
      ev("spec", {
        ...spec,
        url: "https://www.wikipedia.org/",
        redirects: ["https://www.wikipedia.com/", "https://www.wikipedia.org/"],
      }),
      ev("evidence", {
        id: "ev_009",
        page: "/ @ desktop 1440",
        kind: "screenshot",
        tool: "anchor",
        status: "not_observed",
        capturedAt: "2026-10-16T12:00:00.000Z",
        hash: "sha256:00",
        limits: "Capture failed: Anchor POST sessions failed with 403",
      }),
    ]);
    expect(redirected.draftSpec).toMatchObject({
      url: "https://www.wikipedia.org/",
      redirectedFrom: "https://www.wikipedia.com/",
    });
    expect(redirected.evidence).toEqual([
      expect.objectContaining({
        id: "ev_009",
        label: "not_observed",
        src: undefined,
      }),
    ]);
  });

  it("tracks the phase and whether a preview is served", () => {
    expect(view.phase).toBe("building");
    expect(view.hasPreview).toBe(true);
    expect(runView("r1", events.slice(0, 3)).hasPreview).toBe(false);
  });

  it("drives the kanban: columns, reviews, preview and failures", () => {
    const board = deriveBoard(view.board);
    expect(board.runStopped).toBe(false);
    const [t01, t02] = board.tasks;
    expect(t01).toMatchObject({
      id: "t01",
      title: "Task t01",
      state: "merged",
      column: "merged",
      review: {
        verdict: "approved",
        reason: "All criteria met",
        diffSummary: "index.html | 12 +",
      },
    });
    expect(t01?.log.map((line) => line.message)).toEqual(
      expect.arrayContaining([
        "Preview updated with this task",
        "Verifier passed: Hero matches",
      ]),
    );
    expect(t02).toMatchObject({
      state: "failed",
      column: "in_review",
      reason: "Pricing cards missing",
      nextAction: "Ask the user in chat: retry, override, or drop",
      review: { verdict: "rejected", diffSummary: "No cards" },
    });
  });

  it("marks the build stopped when the run stops", () => {
    const stopped = runView("r1", [
      ...events,
      ev("task", task("t03", "stopped", { nextAction: "Restart the build" })),
      ev("phase", { phase: "stopped" }),
    ]);
    expect(stopped.phase).toBe("stopped");
    expect(deriveBoard(stopped.board).runStopped).toBe(true);
  });

  it("skips malformed payloads and unsafe links", () => {
    const odd = runView("r1", [
      ev("spec", { pages: "nope" }),
      ev("evidence", {
        id: "ev_9",
        page: "/",
        kind: "screenshot",
        tool: "anchor",
        status: "observed",
        capturedAt: "2026-10-16T12:00:00.000Z",
        hash: "",
        limits: "",
        url: "https://evil.example/x.png",
      }),
      ev("preview", { mergedTask: 7 }),
      ev("task", { id: "t1" }),
    ]);
    expect(odd).toEqual({ hasPreview: false, evidence: [], board: [] });
  });
  it("shows unavailable replacements as not observed", () => {
    const screenshot = events.find((e) => e.type === "evidence");
    expect(screenshot).toBeDefined();
    if (!screenshot) throw new Error("Missing screenshot event");
    const replaced = runView("r1", [
      screenshot,
      ev("evidence", {
        ...(screenshot.data as Record<string, unknown>),
        status: "not_observed",
        url: undefined,
      }),
    ]).evidence;
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({
      label: "not_observed",
      src: undefined,
    });
  });
});
