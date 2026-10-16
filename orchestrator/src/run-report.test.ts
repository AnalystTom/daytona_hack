import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GOLDMAN_GOAL,
  GOLDMAN_URL,
  ReportDissection,
} from "../../src/shared/report";
import { reportContractExample } from "../../src/shared/report.test-data";
import { captureReport } from "./report-capture";
import { dissect } from "./dissection";
import { latestReport, saveEdit, saveReport } from "./report-store";
import { Run } from "./run";
import type { Env } from "./types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: DurableObjectState,
      public env: Env,
    ) {}
  },
}));
vi.mock("./report-capture", () => ({
  captureReport: vi.fn(),
  attachRegions: vi.fn(),
}));
vi.mock("./dissection", () => ({ dissect: vi.fn() }));
vi.mock("./report-store", () => ({
  saveReport: vi.fn(),
  latestReport: vi.fn(),
  saveEdit: vi.fn(),
}));
vi.mock("./services", () => ({
  remember: vi.fn(),
  recall: vi.fn(),
  llmJson: vi.fn(),
  tracing: {},
}));
vi.mock("./tracing", () => ({
  RunTracer: class {
    traceId = "test";
    root() {}
    span(
      _name: string,
      _kind: string,
      _input: unknown,
      fn: (set: () => void) => unknown,
    ) {
      return fn(() => {});
    }
  },
}));

afterEach(() => vi.clearAllMocks());

function createRun() {
  const data = new Map<string, unknown>();
  const ctx = {
    blockConcurrencyWhile: vi.fn(),
    waitUntil: vi.fn(),
    storage: {
      get: async (key: string) => data.get(key),
      put: async (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      },
      setAlarm: vi.fn(),
      deleteAlarm: vi.fn(),
    },
  };
  const run = new Run(
    ctx as unknown as DurableObjectState,
    { MAX_WORKERS: "12" } as Env,
  );
  return { run, ctx, data };
}
const report = () => ReportDissection.parse(reportContractExample);

describe("bounded Goldman Sachs demo", () => {
  it("approves the fixed scope and research plan then persists a dashboard without a build worker", async () => {
    const { run, data } = createRun();
    vi.mocked(captureReport).mockResolvedValue({
      article: {
        html: "captured",
        url: GOLDMAN_URL,
        capturedAt: report().completedAt,
        hash: "hash",
      },
      evidence: [],
      blobs: {},
      boxes: [],
      pageWidth: 1440,
      pageHeight: 900,
    });
    vi.mocked(dissect).mockResolvedValue(report());
    const start = await run.start("test-run", GOLDMAN_URL, GOLDMAN_GOAL);
    expect(start).toMatchObject({
      phase: "inspecting",
      demo: true,
      spec: { approved: true, flows: [], openQuestions: [] },
    });
    expect(start.sandboxId).toBeUndefined();
    await run.alarm();
    expect(saveReport).toHaveBeenCalledWith(
      expect.anything(),
      { report: report(), evidence: [] },
      true,
    );
    expect(await run.getState()).toMatchObject({
      phase: "done",
      report: report(),
      tasks: [],
    });
    expect(
      [...data.values()].some(
        (v) => (v as { type?: string })?.type === "report",
      ),
    ).toBe(true);
    await expect(run.startBuild()).rejects.toThrow(
      "does not start build workers",
    );
    expect(await run.getState()).not.toHaveProperty("sandboxId");
  });
  it("labels replay with its original run and timestamp when live capture fails", async () => {
    const { run } = createRun();
    vi.mocked(captureReport).mockRejectedValue(
      new Error("Live capture unavailable"),
    );
    vi.mocked(latestReport).mockResolvedValue({
      report: report(),
      evidence: [],
    });
    await run.start("new-run", GOLDMAN_URL, GOLDMAN_GOAL);
    await run.alarm();
    const state = await run.getState();
    expect(state.report).toMatchObject({
      runId: "new-run",
      replay: {
        runId: "test-run",
        completedAt: report().completedAt,
        reason: expect.stringContaining("Live capture unavailable"),
      },
    });
    expect(state.phase).toBe("done");
  });
  it("shows failure when there is no real successful run to replay", async () => {
    const { run } = createRun();
    vi.mocked(captureReport).mockRejectedValue(new Error("Capture failed"));
    vi.mocked(latestReport).mockResolvedValue(undefined);
    await run.start("new-run", GOLDMAN_URL, GOLDMAN_GOAL);
    await run.alarm();
    expect(await run.getState()).toMatchObject({
      phase: "failed",
      error: expect.stringContaining("no successful replay"),
    });
    expect((await run.getState()).report).toBeUndefined();
  });
  it("saves an edit separately and leaves the captured original unchanged", async () => {
    const { run } = createRun();
    vi.mocked(captureReport).mockResolvedValue({
      article: {
        html: "captured",
        url: GOLDMAN_URL,
        capturedAt: report().completedAt,
        hash: "hash",
      },
      evidence: [],
      blobs: {},
      boxes: [],
      pageWidth: 1440,
      pageHeight: 900,
    });
    vi.mocked(dissect).mockResolvedValue(report());
    await run.start("test-run", GOLDMAN_URL, GOLDMAN_GOAL);
    await run.alarm();
    const edited = await run.editReport("f1", {
      label: "Edited",
      value: "$580 billion",
    });
    expect(saveEdit).toHaveBeenCalledWith(expect.anything(), "test-run", "f1", {
      label: "Edited",
      value: "$580 billion",
    });
    expect(edited.figures[0].value).toBe("$581 billion");
    expect(edited.edits.f1.value).toBe("$580 billion");
    await expect(
      run.editReport("unknown", { label: "Edited", value: "1" }),
    ).rejects.toThrow("Unknown report figure");
    await expect(
      run.editReport("f1", { label: "", value: "1" }),
    ).rejects.toThrow();
  });
});

it("keeps a stopped report stopped when its in-flight capture later finishes", async () => {
  const { run } = createRun();
  let finish!: (value: Awaited<ReturnType<typeof captureReport>>) => void;
  vi.mocked(captureReport).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await run.start("test-run", GOLDMAN_URL, GOLDMAN_GOAL);
  const alarm = run.alarm();
  await run.stop();
  finish({
    article: {
      html: "captured",
      url: GOLDMAN_URL,
      capturedAt: report().completedAt,
      hash: "hash",
    },
    evidence: [],
    blobs: {},
    boxes: [],
    pageWidth: 1440,
    pageHeight: 900,
  });
  await alarm;
  expect((await run.getState()).phase).toBe("stopped");
  expect((await run.getState()).report).toBeUndefined();
  expect(dissect).not.toHaveBeenCalled();
  expect(saveReport).not.toHaveBeenCalled();
});
