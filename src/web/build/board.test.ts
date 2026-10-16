import { describe, expect, it } from "vitest";
import type { BuildEvent } from "../../shared/build";
import { deriveBoard } from "./board";

// Test fixtures only: hand-written events, never shown as a live result.
let next = 0;
function event(
  overrides: Partial<BuildEvent> & { detail?: unknown },
): BuildEvent & { detail?: unknown } {
  next += 1;
  return {
    schemaVersion: 1,
    eventId: `evt_${next}`,
    sequence: next,
    runId: "run_1",
    taskId: "task_hero",
    timestamp: "2026-10-16T12:00:00Z",
    type: "task.state_changed",
    state: "queued",
    message: "",
    artifactRefs: [],
    ...overrides,
  };
}

describe("deriveBoard", () => {
  it("is empty with no events", () => {
    expect(deriveBoard([])).toEqual({ tasks: [], runStopped: false });
  });

  it("applies events in sequence order, not arrival order", () => {
    const board = deriveBoard([
      event({ eventId: "c", sequence: 3, state: "in_review" }),
      event({ eventId: "a", sequence: 1, state: "queued" }),
      event({ eventId: "b", sequence: 2, state: "building" }),
    ]);
    expect(board.tasks[0]).toMatchObject({
      state: "in_review",
      column: "in_review",
    });
  });

  it("ignores a repeated event ID", () => {
    const board = deriveBoard([
      event({ eventId: "a", sequence: 1, state: "building", message: "go" }),
      event({ eventId: "a", sequence: 5, state: "merged", message: "go" }),
    ]);
    expect(board.tasks[0]?.state).toBe("building");
    expect(board.tasks[0]?.log).toHaveLength(1);
  });

  it("keeps a stopped task stopped when later events arrive", () => {
    const board = deriveBoard([
      event({ sequence: 1, state: "building" }),
      event({ sequence: 2, state: "stopped", message: "Stopped by user" }),
      event({ sequence: 4, state: "merged", message: "late merge" }),
      event({ sequence: 3, state: "building", message: "late build" }),
    ]);
    expect(board.tasks[0]).toMatchObject({
      state: "stopped",
      column: "building",
      reason: "Stopped by user",
    });
    expect(board.tasks[0]?.log.map((line) => line.message)).toEqual([
      "Stopped by user",
    ]);
  });

  it("keeps a failed task in its last column with reason and next action", () => {
    const board = deriveBoard([
      event({ sequence: 1, state: "in_review" }),
      event({
        sequence: 2,
        state: "failed",
        message: "Review rejected twice",
        detail: { nextAction: "Reply in chat to retry or drop it." },
      }),
    ]);
    expect(board.tasks[0]).toMatchObject({
      state: "failed",
      column: "in_review",
      reason: "Review rejected twice",
      nextAction: "Reply in chat to retry or drop it.",
    });
  });

  it("keeps the failure reason when later events repeat the failed state", () => {
    const board = deriveBoard([
      event({
        sequence: 1,
        state: "failed",
        message: "Tests failed twice",
        detail: { nextAction: "Reply in chat to retry" },
      }),
      event({
        sequence: 2,
        state: "failed",
        message: "Orchestrator notified the user",
      }),
    ]);
    expect(board.tasks[0]).toMatchObject({
      reason: "Tests failed twice",
      nextAction: "Reply in chat to retry",
    });
    expect(board.tasks[0]?.log).toHaveLength(2);
  });

  it("lets an explicit detail reason replace the failure reason", () => {
    const board = deriveBoard([
      event({ sequence: 1, state: "failed", message: "Tests failed twice" }),
      event({
        sequence: 2,
        state: "failed",
        message: "Diagnosis done",
        detail: { reason: "Missing font asset" },
      }),
    ]);
    expect(board.tasks[0]?.reason).toBe("Missing font asset");
  });

  it("clears the failure once a failed task is retried", () => {
    const board = deriveBoard([
      event({ sequence: 1, state: "failed", message: "Tests failed" }),
      event({ sequence: 2, state: "building" }),
    ]);
    expect(board.tasks[0]).toMatchObject({
      state: "building",
      column: "building",
    });
    expect(board.tasks[0]?.reason).toBeUndefined();
  });

  it("merges task detail across events and drops unsafe links", () => {
    const board = deriveBoard([
      event({ sequence: 1, detail: { title: "Hero section" } }),
      event({
        sequence: 2,
        state: "in_review",
        detail: {
          previewUrl: "https://preview.example/hero",
          review: { diffSummary: "+120 -4 in Hero.tsx" },
        },
      }),
      event({
        sequence: 3,
        state: "in_review",
        detail: { review: { verdict: "approved", reason: "Matches evidence" } },
      }),
      event({ sequence: 4, detail: { previewUrl: "javascript:alert(1)" } }),
      event({ sequence: 5, detail: { previewUrl: "/\\evil.example" } }),
      event({ sequence: 6, detail: { previewUrl: "//evil.example" } }),
    ]);
    expect(board.tasks[0]).toMatchObject({
      title: "Hero section",
      previewUrl: "https://preview.example/hero",
      review: {
        diffSummary: "+120 -4 in Hero.tsx",
        verdict: "approved",
        reason: "Matches evidence",
      },
    });
  });

  it("drops only the invalid field of an event's detail", () => {
    const board = deriveBoard([
      event({
        sequence: 1,
        state: "in_review",
        detail: {
          title: "Hero section",
          previewUrl: "javascript:alert(1)",
          review: {
            verdict: "approved",
            reason: "Looks right",
            diffUrl: "diff/12",
          },
        },
      }),
    ]);
    expect(board.tasks[0]?.title).toBe("Hero section");
    expect(board.tasks[0]?.previewUrl).toBeUndefined();
    expect(board.tasks[0]?.review).toEqual({
      verdict: "approved",
      reason: "Looks right",
    });
  });

  it("clears the previous review round when the task goes back to building", () => {
    const board = deriveBoard([
      event({
        sequence: 1,
        state: "in_review",
        detail: {
          review: {
            verdict: "rejected",
            reason: "Hero spacing off",
            diffSummary: "+120 -4 in Hero.tsx",
          },
        },
      }),
      event({ sequence: 2, state: "building" }),
      event({
        sequence: 3,
        state: "in_review",
        detail: { review: { diffSummary: "+8 -2 in Hero.tsx" } },
      }),
    ]);
    expect(board.tasks[0]?.review).toEqual({
      diffSummary: "+8 -2 in Hero.tsx",
    });
  });

  it("keeps a rejected task's next action", () => {
    const board = deriveBoard([
      event({
        sequence: 1,
        state: "in_review",
        detail: {
          nextAction: "Builder will rework the hero",
          review: { verdict: "rejected", reason: "Hero spacing off" },
        },
      }),
      event({
        sequence: 2,
        state: "in_review",
        message: "Orchestrator sending task back to builder",
      }),
    ]);
    expect(board.tasks[0]).toMatchObject({
      nextAction: "Builder will rework the hero",
      review: { verdict: "rejected", reason: "Hero spacing off" },
    });
  });

  it("marks the run stopped from a run-level event", () => {
    const board = deriveBoard([
      event({ sequence: 1, state: "building" }),
      event({ sequence: 2, taskId: undefined, state: "stopped" }),
    ]);
    expect(board.runStopped).toBe(true);
    expect(board.tasks).toHaveLength(1);
  });

  it("keeps tasks in first-seen order", () => {
    const board = deriveBoard([
      event({ sequence: 2, taskId: "task_footer" }),
      event({ sequence: 1, taskId: "task_nav" }),
    ]);
    expect(board.tasks.map((task) => task.id)).toEqual([
      "task_nav",
      "task_footer",
    ]);
  });
});
