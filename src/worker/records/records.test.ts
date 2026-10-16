import { describe, expect, it } from "vitest";
import { MemoryRunStore } from "../store/memory";
import { recordRunEvent } from "./records";

const run = {
  id: "run-1",
  url: "https://example.com/",
  goal: "",
  startedAt: "2026-10-16T12:00:00.000Z",
};
const event = (seq: number, type: string, data: unknown) => ({
  run,
  event: { seq, ts: `2026-10-16T12:00:0${seq}.000Z`, type, data },
});

describe("recordRunEvent", () => {
  it("creates the run, keeps each event whole and tracks tasks, steering and approval", async () => {
    const store = new MemoryRunStore();
    await recordRunEvent(store, event(1, "chat", { role: "user", text: "Go" }));
    await recordRunEvent(store, event(2, "phase", { phase: "inspecting" }));
    await recordRunEvent(
      store,
      event(3, "task", { id: "t01", status: "building", title: "Base" }),
    );
    await recordRunEvent(
      store,
      event(4, "verification", { taskId: "t01", pass: false, summary: "Off" }),
    );
    await recordRunEvent(store, event(5, "phase", { phase: "stopped" }));
    // A retried event is stored once.
    await recordRunEvent(store, event(5, "phase", { phase: "stopped" }));

    const records = store.runs.get("run-1");
    expect(records?.run).toMatchObject({
      goal: "https://example.com/",
      status: "stopped",
      specApprovedAt: "2026-10-16T12:00:02.000Z",
    });
    expect(records?.events.map((e) => [e.type, e.state, e.message])).toEqual([
      ["chat", "chat", "Go"],
      ["phase", "inspecting", ""],
      ["task", "building", ""],
      ["verification", "fail", "Off"],
      ["phase", "stopped", ""],
    ]);
    expect(records?.events[2]).toMatchObject({
      data: { id: "t01", title: "Base" },
    });
    expect(await store.listTasks("run-1")).toMatchObject([
      { taskId: "t01", state: "building" },
    ]);
    expect(records?.steering.map((s) => s.kind)).toEqual(["message", "stop"]);
    expect(records?.approvals).toHaveLength(1);
  });

  it("rejects a malformed record", async () => {
    await expect(
      recordRunEvent(new MemoryRunStore(), { run, event: { seq: 0 } }),
    ).rejects.toThrow();
  });
});
