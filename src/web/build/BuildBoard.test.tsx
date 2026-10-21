import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuildBoard } from "./BuildBoard";

const noop = () => {};

describe("BuildBoard", () => {
  it("shows the empty state and a disabled Stop build before any task", () => {
    const html = renderToStaticMarkup(
      <BuildBoard events={[]} onStopBuild={noop} />,
    );
    expect(html).toContain("No build started.");
    expect(html).toContain("Tasks appear after the spec is approved.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Stop build<\/button>/);
  });

  it("shows what the run is doing while no tasks exist yet", () => {
    const html = renderToStaticMarkup(
      <BuildBoard
        events={[]}
        status="Inspecting the site"
        onStopBuild={noop}
      />,
    );
    expect(html).toContain("Inspecting the site");
    expect(html).not.toContain("No build started.");
  });

  it("keeps a failed task visible with its reason and next action", () => {
    // Test fixture only.
    const html = renderToStaticMarkup(
      <BuildBoard
        onStopBuild={noop}
        events={[
          {
            schemaVersion: 1,
            eventId: "evt_1",
            sequence: 1,
            runId: "run_1",
            taskId: "task_hero",
            timestamp: "2026-10-16T12:00:00Z",
            type: "task.state_changed",
            state: "failed",
            message: "Tests failed twice",
            artifactRefs: [],
            detail: { title: "Hero section" },
          },
        ]}
      />,
    );
    expect(html).not.toContain("No build started.");
    expect(html).toContain("Hero section");
    expect(html).toContain("Failed");
    expect(html).toContain("Tests failed twice");
    expect(html).toContain("Reply in chat to decide what happens next.");
  });

  it("keeps a rejected task visible with its reason and next action", () => {
    // Test fixture only.
    const html = renderToStaticMarkup(
      <BuildBoard
        onStopBuild={noop}
        events={[
          {
            schemaVersion: 1,
            eventId: "evt_1",
            sequence: 1,
            runId: "run_1",
            taskId: "task_hero",
            timestamp: "2026-10-16T12:00:00Z",
            type: "task.state_changed",
            state: "in_review",
            message: "",
            artifactRefs: [],
            detail: {
              title: "Hero section",
              nextAction: "Builder will rework the hero",
              review: { verdict: "rejected", reason: "Hero spacing off" },
            },
          },
        ]}
      />,
    );
    expect(html).toContain("Rejected");
    expect(html).toContain("Hero spacing off");
    expect(html).toContain("Builder will rework the hero");
  });

  it("falls back to the default next action when a task fails after review", () => {
    // Test fixture only.
    const base = {
      schemaVersion: 1 as const,
      runId: "run_1",
      taskId: "task_hero",
      timestamp: "2026-10-16T12:00:00Z",
      type: "task.state_changed",
      artifactRefs: [],
    };
    const html = renderToStaticMarkup(
      <BuildBoard
        onStopBuild={noop}
        events={[
          {
            ...base,
            eventId: "evt_1",
            sequence: 1,
            state: "in_review",
            message: "",
            detail: { nextAction: "Builder will rework the hero" },
          },
          {
            ...base,
            eventId: "evt_2",
            sequence: 2,
            state: "failed",
            message: "Rejected twice, giving up",
          },
        ]}
      />,
    );
    expect(html).toContain("Rejected twice, giving up");
    expect(html).toContain("Reply in chat to decide what happens next.");
    expect(html).not.toContain("Builder will rework the hero");
  });
});
