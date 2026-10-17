import { afterEach, expect, it, vi } from "vitest";
import {
  AnchorError,
  CodeExecutionRefused,
  createSession,
  endSession,
  runSnippet,
  screenshotTool,
} from "../../src/worker/evidence/anchor";
import { extractFigures } from "./dissection";
import { captureReport } from "./report-capture";
import type { Env } from "./types";

vi.mock("../../src/worker/evidence/anchor", async (original) => ({
  ...(await original<typeof import("../../src/worker/evidence/anchor")>()),
  createSession: vi.fn(),
  endSession: vi.fn(),
  runSnippet: vi.fn(),
  screenshotTool: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "retains the resolved article identity with Anchor configured: %s",
  async (anchor) => {
    const url = "https://www.goldmansachs.com/resolved-article";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.endsWith("/article")
          ? new Response(null, { status: 302, headers: { location: url } })
          : new Response("<h1>Investment in 2026</h1>"),
      ),
    );
    vi.mocked(createSession).mockResolvedValue({ id: "session" } as Awaited<
      ReturnType<typeof createSession>
    >);
    vi.mocked(runSnippet).mockResolvedValue({
      url,
      html: "<h1>Investment in 2026</h1>",
      png: "",
      boxes: [],
      pageWidth: 1440,
      pageHeight: 900,
    });
    const capture = await captureReport(
      { ANCHORBROWSER_API_KEY: anchor ? "test" : undefined } as Env,
      "https://www.goldmansachs.com/article",
    );
    expect(capture.article.url).toBe(url);
    expect(capture.evidence[0].page).toBe("/resolved-article");
    if (anchor) expect(endSession).toHaveBeenCalledWith("test", "session");
  },
);

it("falls back to fetched HTML and the screenshot tool when code execution is refused", async () => {
  const url = "https://www.goldmansachs.com/article";
  const resolvedUrl = "https://www.goldmansachs.com/resolved-article";
  const html =
    "<h1>Investment</h1><p>That projection points to $1 trillion of AI-related investment around the globe in 2026, including $581 billion in the US.</p>";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      input === url
        ? new Response(null, {
            status: 302,
            headers: { location: resolvedUrl },
          })
        : new Response(html),
    ),
  );
  vi.mocked(createSession).mockResolvedValue({ id: "session" } as Awaited<
    ReturnType<typeof createSession>
  >);
  vi.mocked(runSnippet).mockRejectedValue(
    new CodeExecutionRefused(
      'Anchor POST /v1/tools/execute-code failed with 403: {"code":403,"error":"Code execution is not enabled for this team"}',
    ),
  );
  vi.mocked(screenshotTool).mockResolvedValue(new Uint8Array([1, 2, 3]));
  const capture = await captureReport(
    { ANCHORBROWSER_API_KEY: "test" } as Env,
    url,
  );
  expect(screenshotTool).toHaveBeenCalledWith("test", "session", resolvedUrl, {
    width: 1440,
    height: 900,
  });
  expect(capture.article.html).toBe(html);
  expect(capture.article.url).toBe(resolvedUrl);
  expect(capture.boxes).toEqual([]);
  expect(capture.evidence[0]).toMatchObject({
    tool: "fetch",
    status: "observed",
  });
  expect(capture.evidence[1]).toMatchObject({ status: "inferred" });
  expect(capture.evidence[1].limits).toContain("not enabled for this team");
  expect(capture.blobs.ev_report_screen).toBeDefined();
  const figures = extractFigures(capture.article.html);
  expect(figures.map((f) => f.value)).toContain("$581 billion");
  for (const f of figures)
    expect(f.location).toMatchObject({ start: expect.any(Number) });
  expect(endSession).toHaveBeenCalledWith("test", "session");
});

it.each([
  "Anchor snippet failed: Report redirected to another origin",
  "Anchor POST /v1/tools/execute-code failed with 500",
])("rethrows non-refusal Anchor errors: %s", async (message) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.mocked(createSession).mockResolvedValue({ id: "session" } as Awaited<
    ReturnType<typeof createSession>
  >);
  const error = new AnchorError(message);
  vi.mocked(runSnippet).mockRejectedValue(error);
  await expect(
    captureReport(
      { ANCHORBROWSER_API_KEY: "test" } as Env,
      "https://www.goldmansachs.com/article",
    ),
  ).rejects.toBe(error);
  expect(fetch).not.toHaveBeenCalled();
  expect(screenshotTool).not.toHaveBeenCalled();
  expect(endSession).toHaveBeenCalledWith("test", "session");
});

it.each([
  ["https://example.com/article", "Report redirected to another origin"],
  ["http://www.goldmansachs.com/article", "Source redirect is not public HTTP(S)"],
  [
    "https://www.goldmansachs.com:8443/article",
    "Report redirected to another origin",
  ],
])("rejects a fallback redirect to another origin: %s", async (redirect, error) => {
  const url = "https://www.goldmansachs.com/article";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      input === url
        ? new Response(null, { status: 302, headers: { location: redirect } })
        : new Response("<h1>Different report</h1>"),
    ),
  );
  vi.mocked(createSession).mockResolvedValue({ id: "session" } as Awaited<
    ReturnType<typeof createSession>
  >);
  vi.mocked(runSnippet).mockRejectedValue(new CodeExecutionRefused("403"));
  await expect(
    captureReport({ ANCHORBROWSER_API_KEY: "test" } as Env, url),
  ).rejects.toThrow(error);
  expect(screenshotTool).not.toHaveBeenCalled();
  expect(endSession).toHaveBeenCalledWith("test", "session");
});

it("records the screenshot as not observed when the fallback screenshot tool also fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("<h1>Investment</h1>")),
  );
  vi.mocked(createSession).mockResolvedValue({ id: "session" } as Awaited<
    ReturnType<typeof createSession>
  >);
  vi.mocked(runSnippet).mockRejectedValue(new CodeExecutionRefused("403"));
  vi.mocked(screenshotTool).mockRejectedValue(
    new AnchorError("Anchor screenshot failed"),
  );
  const capture = await captureReport(
    { ANCHORBROWSER_API_KEY: "test" } as Env,
    "https://www.goldmansachs.com/article",
  );
  expect(capture.evidence[0].status).toBe("observed");
  expect(capture.evidence[1]).toMatchObject({ status: "not_observed" });
  expect(capture.evidence[1].limits).toContain("screenshot tool also failed");
});
