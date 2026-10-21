import { describe, expect, it } from "vitest";
import { EventEnvelope, EvidenceItem, TaskState } from "./contracts";

describe("TaskState", () => {
  it("accepts the kanban states and rejects others", () => {
    for (const state of [
      "queued",
      "building",
      "in_review",
      "merged",
      "failed",
      "stopped",
    ]) {
      expect(TaskState.safeParse(state).success).toBe(true);
    }
    expect(TaskState.safeParse("in review").success).toBe(false);
  });
});

describe("EventEnvelope", () => {
  const event = {
    schemaVersion: 1,
    eventId: "evt_1",
    sequence: 0,
    runId: "run_1",
    timestamp: "2026-10-16T12:00:00Z",
    type: "task.state_changed",
    state: "building",
    message: "Worker started",
    artifactRefs: [],
  };

  it("accepts a valid event with and without a task id", () => {
    expect(EventEnvelope.safeParse(event).success).toBe(true);
    expect(
      EventEnvelope.safeParse({ ...event, taskId: "task_1" }).success,
    ).toBe(true);
  });

  it("rejects a bad sequence, timestamp or schema version", () => {
    expect(EventEnvelope.safeParse({ ...event, sequence: -1 }).success).toBe(
      false,
    );
    expect(
      EventEnvelope.safeParse({ ...event, timestamp: "yesterday" }).success,
    ).toBe(false);
    expect(
      EventEnvelope.safeParse({ ...event, schemaVersion: 2 }).success,
    ).toBe(false);
  });
});

describe("EvidenceItem", () => {
  const item = {
    id: "ev_1",
    kind: "screenshot",
    label: "observed",
    pageOrState: "/ desktop",
    tool: "anchor",
    capturedAt: "2026-10-16T12:00:00Z",
    contentHash: "sha256:abc",
    limitations: [],
  };

  it("accepts a valid item", () => {
    expect(EvidenceItem.safeParse(item).success).toBe(true);
  });

  it("rejects an unknown kind or label", () => {
    expect(EvidenceItem.safeParse({ ...item, kind: "video" }).success).toBe(
      false,
    );
    expect(EvidenceItem.safeParse({ ...item, label: "guessed" }).success).toBe(
      false,
    );
  });
});
