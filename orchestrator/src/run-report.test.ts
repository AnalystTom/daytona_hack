import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GOLDMAN_GOAL,
  GOLDMAN_URL,
  ReportDissection,
} from "../../src/shared/report";
import { reportContractExample } from "../../src/shared/report.test-data";
import { runView } from "../../src/web/workspace/orchestrator";
import { captureReport } from "./report-capture";
import { dissect } from "./dissection";
import { latestReport, saveEdit, saveReport } from "./report-store";
import { capture } from "./inspect";
import { llmJson } from "./services";
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
vi.mock("./inspect", async (original) => ({
  ...(await original<typeof import("./inspect")>()),
  capture: vi.fn(),
}));
vi.mock("./report-store", () => ({
  saveReport: vi.fn(),
  latestReport: vi.fn(),
  saveEdit: vi.fn(),
}));
vi.mock("./services", () => ({
  remember: vi.fn(),
  recall: vi.fn(),
  llmJson: vi.fn(),
  pageHtml: async () => ({ html: "", tool: "fetch" }),
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

function createRun(env: Partial<Env> = {}) {
  const data = new Map<string, unknown>();
  const ctx = {
    blockConcurrencyWhile: vi.fn(),
    waitUntil: vi.fn(),
    storage: {
      get: async (key: string) => data.get(key),
      put: async (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      },
      delete: async (key: string) => data.delete(key),
      list: async ({ prefix, start }: { prefix: string; start: string }) =>
        new Map(
          [...data].filter(([key]) => key.startsWith(prefix) && key >= start),
        ),
      setAlarm: vi.fn(),
      deleteAlarm: vi.fn(),
    },
  };
  const run = new Run(
    ctx as unknown as DurableObjectState,
    { MAX_WORKERS: "12", ...env } as Env,
  );
  return { run, ctx, data };
}
const report = () => ReportDissection.parse(reportContractExample);

it.each([false, true])(
  "replays only originating capture evidence after research fails, prior screenshot=%s",
  async (hasScreen) => {
    const previous = createRun();
    const priorReport = report();
    priorReport.edits.f1 = { label: "Prior edit", value: "Prior value" };
    const makeCapture = (html: string, screenshot: boolean) => ({
      article: {
        html,
        url: GOLDMAN_URL,
        capturedAt: priorReport.completedAt,
        hash: html,
      },
      evidence: [
        {
          id: "ev_report_html",
          kind: "html" as const,
          page: "/",
          tool: "fetch",
          status: "observed" as const,
          capturedAt: priorReport.completedAt,
          hash: html,
          summary: html,
          limits: "Captured HTML",
        },
        {
          id: "ev_report_screen",
          kind: "screenshot" as const,
          page: "/",
          tool: "anchor",
          status: screenshot
            ? ("observed" as const)
            : ("not_observed" as const),
          capturedAt: priorReport.completedAt,
          hash: screenshot ? html : "",
          summary: "Screenshot",
          limits: screenshot ? "Captured screenshot" : "Not observed",
        },
      ],
      blobs: {
        ev_report_html: html,
        ...(screenshot
          ? { ev_report_screen: new Uint8Array([1, 2, 3]).buffer }
          : {}),
      },
      boxes: [],
      pageWidth: 1440,
      pageHeight: 900,
    });
    vi.mocked(captureReport).mockResolvedValueOnce(
      makeCapture("prior capture", hasScreen),
    );
    vi.mocked(dissect).mockResolvedValueOnce(priorReport);
    await previous.run.start("test-run", GOLDMAN_URL, GOLDMAN_GOAL);
    await previous.run.alarm();
    const priorState = await previous.run.getState();
    const runs = {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => previous.run),
    };
    const current = createRun({
      RUNS: runs as unknown as DurableObjectNamespace,
    });
    vi.mocked(captureReport).mockResolvedValueOnce(
      makeCapture("failed live capture", true),
    );
    vi.mocked(dissect).mockRejectedValueOnce(new Error("Research failed"));
    vi.mocked(latestReport).mockResolvedValueOnce({
      report: priorReport,
      evidence: priorState.evidence,
    });
    await current.run.start("new-run", GOLDMAN_URL, GOLDMAN_GOAL);
    await current.run.alarm();
    const state = await current.run.getState();
    expect(state.report).toMatchObject({
      edits: {},
      replay: { runId: "test-run", completedAt: priorReport.completedAt },
    });
    expect(state.report?.figures).toEqual(priorReport.figures);
    expect(state.evidence).toEqual(priorState.evidence);
    expect(current.data.has("blob:ev_report_html")).toBe(false);
    expect(current.data.has("blob:ev_report_screen")).toBe(false);
    const html = await current.run.evidenceFile("ev_report_html");
    expect(new TextDecoder().decode(html?.content)).toBe("prior capture");
    expect(await current.run.evidenceFile("ev_report_screen")).toEqual(
      hasScreen
        ? { contentType: "image/png", content: new Uint8Array([1, 2, 3]) }
        : null,
    );
    const view = runView("new-run", await current.run.events(0));
    expect(view.evidence).toHaveLength(hasScreen ? 1 : 0);
    expect(
      view.evidence.every(
        (e) =>
          e.src.startsWith("/api/v1/runs/test-run/evidence/") &&
          e.contentHash === "prior capture",
      ),
    ).toBe(true);
    expect(runs.idFromName).toHaveBeenCalledWith("test-run");
    expect(priorReport.edits.f1.value).toBe("Prior value");
    await current.run.editReport("f1", {
      label: "New edit",
      value: "New value",
    });
    expect(saveEdit).toHaveBeenLastCalledWith(
      expect.anything(),
      "new-run",
      "f1",
      { label: "New edit", value: "New value" },
    );
    expect(priorReport.edits.f1.value).toBe("Prior value");
  },
);

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

it.each([
  "Reconstruct this landing page",
  "Research this website",
  "Show forecast numbers and figures",
])("keeps the normal reconstruction journey for %s", async (goal) => {
  const { run } = createRun();
  vi.mocked(capture).mockResolvedValueOnce({ status: "captured", items: [] });
  vi.mocked(llmJson).mockResolvedValueOnce({
    reply: "Review the scope",
    spec: {},
    userApproved: false,
  });
  const state = await run.start("website-run", GOLDMAN_URL, goal);
  expect(state).toMatchObject({ phase: "brief", spec: { approved: false } });
  expect(captureReport).not.toHaveBeenCalled();
  await expect(run.startBuild()).rejects.toThrow(
    "tasks appear after the spec is approved",
  );
  await expect(run.approveSpec()).resolves.toMatchObject({
    phase: "inspecting",
    pending: "inspect",
    spec: { approved: true },
  });
});

it("requires scope approval for explicit report mode and then dissects without building", async () => {
  const { run } = createRun();
  vi.mocked(capture).mockResolvedValueOnce({ status: "captured", items: [] });
  vi.mocked(llmJson).mockResolvedValueOnce({
    reply: "Review the report scope",
    spec: {},
    userApproved: false,
  });
  vi.mocked(captureReport).mockResolvedValueOnce({
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
  vi.mocked(dissect).mockResolvedValueOnce(report());
  expect(
    await run.start("test-run", GOLDMAN_URL, "Reconstruct this report"),
  ).toMatchObject({
    phase: "brief",
    spec: { approved: false },
  });
  expect(captureReport).not.toHaveBeenCalled();
  await run.approveSpec();
  await run.alarm();
  expect(await run.getState()).toMatchObject({
    phase: "done",
    report: report(),
  });
  expect(saveReport).toHaveBeenCalledWith(
    expect.anything(),
    { report: report(), evidence: [] },
    false,
  );
  await expect(run.startBuild()).rejects.toThrow(
    "does not start build workers",
  );
});
