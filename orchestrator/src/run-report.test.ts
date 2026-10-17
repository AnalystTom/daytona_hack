import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportDissection } from "../../src/shared/report";
import {
  GOLDMAN_URL,
  reportContractExample,
} from "../../src/shared/report.test-data";
import {
  createSession,
  endSession,
  runSnippet,
} from "../../src/worker/evidence/anchor";
import { captureReport } from "./report-capture";
import { dissect } from "./dissection";
import { saveEdit, saveReport } from "./report-store";
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
vi.mock("../../src/worker/evidence/anchor", () => ({
  createSession: vi.fn(),
  endSession: vi.fn(),
  runSnippet: vi.fn(),
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

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

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

// A typed report-dissection brief: the user answers the one question round, then approves the plan.
const REPORT_GOAL =
  "Reconstruct this report: rebuild its key figures and the investment breakdown as an editable page, link every number to where it appears in the source, and mark anything not observed.";
async function startReport(
  run: Run,
  id: string,
  url = GOLDMAN_URL,
  goal = REPORT_GOAL,
) {
  // The entered address has no redirects; nothing here reaches the network.
  vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
  vi.mocked(capture).mockResolvedValueOnce({ status: "captured", items: [] });
  vi.mocked(llmJson).mockResolvedValueOnce({
    reply: "Review the report scope",
    spec: {},
    userApproved: false,
  });
  const brief = structuredClone(await run.start(id, url, goal));
  await run.approveSpec();
  return brief;
}

describe("report dissection run", () => {
  it("waits for the user to approve the scope, then persists a dashboard without a build worker", async () => {
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
    const start = await startReport(run, "test-run");
    expect(start).toMatchObject({
      phase: "brief",
      spec: { approved: false },
    });
    expect(captureReport).not.toHaveBeenCalled();
    expect(await run.getState()).toMatchObject({
      phase: "inspecting",
      pending: "report",
      spec: { approved: true },
    });
    expect(start.sandboxId).toBeUndefined();
    await run.alarm();
    expect(saveReport).toHaveBeenCalledWith(
      expect.anything(),
      { report: report(), evidence: [] },
      GOLDMAN_URL,
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
  it("dissects any report address and saves it under that address", async () => {
    const { run } = createRun();
    const address = "https://example.org/research/annual-report";
    vi.mocked(captureReport).mockResolvedValue({
      article: {
        html: "captured",
        url: address,
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
    await startReport(run, "any-run", address);
    await run.alarm();
    expect(captureReport).toHaveBeenCalledWith(
      expect.anything(),
      address,
      expect.anything(),
    );
    expect(saveReport).toHaveBeenCalledWith(
      expect.anything(),
      { report: report(), evidence: [] },
      address,
    );
  });
  it.each([GOLDMAN_URL, "https://example.org/report?token=secret#figures"])(
    "surfaces the real capture failure for %s",
    async (address) => {
      const { run } = createRun();
      vi.mocked(captureReport).mockRejectedValueOnce(
        new Error("Capture failed"),
      );
      await startReport(run, "new-run", address);
      await run.alarm();
      expect(await run.getState()).toMatchObject({
        phase: "failed",
        error: "Capture failed",
      });
      expect((await run.getState()).report).toBeUndefined();
      expect(saveReport).not.toHaveBeenCalled();
      expect(
        (await run.events(0)).some((event) => event.type === "report"),
      ).toBe(false);
    },
  );
  it.each(["research", "persistence"])(
    "keeps its own evidence and fails when report %s fails",
    async (stage) => {
      const otherRun = { evidenceFile: vi.fn() };
      const runs = { idFromName: vi.fn(), get: vi.fn(() => otherRun) };
      const { run } = createRun({
        RUNS: runs as unknown as DurableObjectNamespace,
      });
      vi.mocked(captureReport).mockResolvedValueOnce({
        article: {
          html: "current capture",
          url: GOLDMAN_URL,
          capturedAt: report().completedAt,
          hash: "current",
        },
        evidence: [
          {
            id: "ev_report_html",
            kind: "html",
            page: "/",
            tool: "fetch",
            status: "observed",
            capturedAt: report().completedAt,
            hash: "current",
            summary: "Current capture",
            limits: "",
          },
        ],
        blobs: { ev_report_html: "current capture" },
        boxes: [],
        pageWidth: 1440,
        pageHeight: 900,
      });
      const error = `${stage} failed`;
      if (stage === "research")
        vi.mocked(dissect).mockRejectedValueOnce(new Error(error));
      else {
        vi.mocked(dissect).mockResolvedValueOnce(report());
        vi.mocked(saveReport).mockRejectedValueOnce(new Error(error));
      }
      await startReport(run, "new-run");
      await run.alarm();
      expect(await run.getState()).toMatchObject({ phase: "failed", error });
      expect((await run.getState()).report).toBeUndefined();
      const html = await run.evidenceFile("ev_report_html");
      expect(new TextDecoder().decode(html?.content)).toBe("current capture");
      expect(await run.evidenceFile("prior-run-only")).toBeNull();
      expect(runs.get).not.toHaveBeenCalled();
      expect(saveReport).toHaveBeenCalledTimes(stage === "research" ? 0 : 1);
    },
  );
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
    await startReport(run, "test-run");
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

it("closes the report Anchor session on stop before capture finishes", async () => {
  const actual =
    await vi.importActual<typeof import("./report-capture")>(
      "./report-capture",
    );
  vi.mocked(captureReport).mockImplementationOnce(actual.captureReport);
  vi.mocked(createSession).mockResolvedValueOnce({
    id: "report-session",
    liveViewUrl: "",
  });
  vi.mocked(endSession).mockResolvedValue(undefined);
  let release!: (value: unknown) => void;
  let started!: () => void;
  const capturing = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(runSnippet).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      }),
  );
  const { run, data } = createRun({ ANCHORBROWSER_API_KEY: "test" });
  await startReport(run, "test-run");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const alarm = run.alarm();
  await capturing;
  await run.stop();
  expect(endSession).toHaveBeenCalledExactlyOnceWith("test", "report-session");
  expect(vi.mocked(runSnippet).mock.calls.at(-1)?.[3]?.aborted).toBe(true);
  release({});
  await alarm;
  expect((await run.getState()).phase).toBe("stopped");
  expect((await run.getState()).evidence).toEqual([]);
  expect([...data.keys()].some((key) => key.startsWith("blob:"))).toBe(false);
  expect(endSession).toHaveBeenCalledTimes(1);
  expect(dissect).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it("stops report research without starting source requests", async () => {
  const actual =
    await vi.importActual<typeof import("./dissection")>("./dissection");
  vi.mocked(dissect).mockImplementationOnce(actual.dissect);
  vi.mocked(captureReport).mockResolvedValueOnce({
    article: {
      html: "<h1>Investment reaches $35 billion</h1>",
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
  let release!: (value: unknown) => void;
  let started!: () => void;
  const researching = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { run } = createRun();
  await startReport(run, "test-run");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  vi.mocked(llmJson).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      }),
  );
  const alarm = run.alarm();
  await researching;
  await run.stop();
  expect(vi.mocked(llmJson).mock.calls.at(-1)?.[1].signal?.aborted).toBe(true);
  release({
    sources: [],
    traces: [
      {
        figureId: "article_f1",
        url: "https://research.example/source",
        value: "$35 billion",
        quote: "Investment reaches $35 billion",
        status: "matches",
      },
    ],
  });
  await alarm;
  expect(fetcher).not.toHaveBeenCalled();
  expect(saveReport).not.toHaveBeenCalled();
  expect((await run.getState()).phase).toBe("stopped");
  expect((await run.getState()).report).toBeUndefined();
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
  await startReport(run, "test-run");
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
  "Rebuild this website and report accessibility issues",
  "Reconstruct this website and report accessibility issues",
  "Report accessibility issues",
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

it.each([
  "Reconstruct this report",
  "Dissect this report",
  "Rebuild the financial report",
  "Reconstruct a report",
])(
  "requires scope approval for %s and then dissects without building",
  async (goal) => {
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
    expect(await run.start("test-run", GOLDMAN_URL, goal)).toMatchObject({
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
      GOLDMAN_URL,
    );
    await expect(run.startBuild()).rejects.toThrow(
      "does not start build workers",
    );
  },
);
