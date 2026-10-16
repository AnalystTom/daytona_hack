import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionTitle } from "./SessionSwitcher";
import {
  listSessions,
  loadLayout,
  rememberSession,
  saveLayout,
} from "./sessions";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
});

describe("sessions", () => {
  it("lists runs newest first and fills in what becomes known", () => {
    rememberSession({ runId: "run-a", target: "https://a.example/" }, 1);
    rememberSession({ runId: "run-b" }, 2);
    rememberSession({ runId: "run-a", phase: "planning" }, 3);
    expect(listSessions()).toEqual([
      {
        runId: "run-a",
        target: "https://a.example/",
        phase: "planning",
        updatedAt: 3,
      },
      { runId: "run-b", updatedAt: 2 },
    ]);
  });

  it("ignores unreadable storage", () => {
    localStorage.setItem("reversy.sessions", "{not json");
    expect(listSessions()).toEqual([]);
    localStorage.setItem(
      "reversy.sessions",
      JSON.stringify([{ runId: "../x", updatedAt: 1 }]),
    );
    expect(listSessions()).toEqual([]);
  });

  it("keeps card positions per run", () => {
    saveLayout("run-a", { "draft-spec": { x: 40, y: -20 } });
    expect(loadLayout("run-a")).toEqual({ "draft-spec": { x: 40, y: -20 } });
    expect(loadLayout("run-b")).toEqual({});
  });

  it("names a session by its target, or its run until one is known", () => {
    expect(
      sessionTitle({ runId: "r", target: "https://www.gs.com/insights/x" }),
    ).toBe("www.gs.com/insights/x");
    expect(sessionTitle({ runId: "r", target: "https://a.example/" })).toBe(
      "a.example",
    );
    expect(sessionTitle({ runId: "0123456789abcdef" })).toBe("Run 01234567");
  });
});
