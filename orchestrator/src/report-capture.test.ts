import { afterEach, expect, it, vi } from "vitest";
import {
  createSession,
  endSession,
  runSnippet,
} from "../../src/worker/evidence/anchor";
import { captureReport } from "./report-capture";
import type { Env } from "./types";

vi.mock("../../src/worker/evidence/anchor", () => ({
  createSession: vi.fn(),
  endSession: vi.fn(),
  runSnippet: vi.fn(),
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
