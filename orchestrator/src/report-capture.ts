import {
  AnchorError,
  CodeExecutionRefused,
  createSession,
  endSession,
  runSnippet,
  screenshotTool,
} from "../../src/worker/evidence/anchor";
import type { CaptureDeps } from "../../src/worker/evidence/capture";
import type { ReportFigure } from "../../src/shared/report";
import { sourceFetch } from "./dissection";
import { sha256 } from "./services";
import type { Env, Evidence } from "./types";

type Region = NonNullable<ReportFigure["location"]["screenshot"]>;
type Box = Omit<Region, "evidenceId" | "pageWidth" | "pageHeight"> & {
  text: string;
  iframe: boolean;
};

/** The screenshot and locations come from the same isolated Anchor page. */
export async function captureReport(
  env: Env,
  url: string,
  control: Pick<CaptureDeps, "signal" | "onSession"> = {},
) {
  const { signal } = control;
  signal?.throwIfAborted();
  let html: string;
  let screenshot: ArrayBuffer | undefined;
  let boxes: Box[] = [];
  let pageWidth = 0;
  let pageHeight = 0;
  let limitation = "Anchor not configured; screenshot coordinates not observed";
  let tool: "anchor" | "fetch" = "fetch";
  let shotStatus: "observed" | "inferred" = "observed";
  if (env.ANCHORBROWSER_API_KEY) {
    const key = env.ANCHORBROWSER_API_KEY;
    const session = await createSession(key, { recording: false });
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= endSession(key, session.id));
    control.onSession?.(close);
    const abort = () => {
      void close().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      let bytes: Uint8Array | undefined;
      try {
        const capture = await runSnippet<{
          html: string;
          url: string;
          png: string;
          boxes: Box[];
          pageWidth: number;
          pageHeight: number;
        }>(
          key,
          session.id,
          `
await page.setViewportSize({ width: 1440, height: 900 });
const navigation = await page.goto(${JSON.stringify(url)}, { waitUntil: "load", timeout: 45000 });
if (!navigation || !navigation.ok()) throw new Error("Report navigation failed");
if (new URL(page.url()).origin !== new URL(${JSON.stringify(url)}).origin) throw new Error("Report redirected to another origin");
await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
// Load lazy chart content before taking the full-page evidence.
for (const frame of await page.locator("iframe").all()) await frame.scrollIntoViewIfNeeded().catch(() => {});
await page.evaluate(() => window.scrollTo(0, 0));
const locations = await page.evaluate(() => {
  const boxes = Array.from(document.querySelectorAll("h1,h2,h3,h4,p,li,figcaption,td,th,iframe")).map((el) => {
    const r = el.getBoundingClientRect();
    return { text: el.tagName === "IFRAME" ? el.getAttribute("src") || "" : el.textContent || "", iframe: el.tagName === "IFRAME", x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
  }).filter((r) => r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0);
  return { boxes, pageWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight };
});
const png = Buffer.from(await page.screenshot({ fullPage: true, type: "png", scale: "css" })).toString("base64");
return { html: await page.content(), url: page.url(), png, ...locations };
`,
          signal,
        );
        signal?.throwIfAborted();
        tool = "anchor";
        html = capture.html;
        url = capture.url;
        bytes = Uint8Array.from(atob(capture.png), (c) => c.charCodeAt(0));
        if (bytes.byteLength < 1_900_000) {
          boxes = capture.boxes;
          pageWidth = capture.pageWidth;
          pageHeight = capture.pageHeight;
          limitation =
            "1440px full-page screenshot and DOM boxes from the same capture; chart boxes identify the embedded chart, not individual plotted marks";
        }
      } catch (error) {
        signal?.throwIfAborted();
        // Code execution can be off for the account: read the page over HTTP and use the plain screenshot tool.
        if (!(error instanceof CodeExecutionRefused)) throw error;
        const page = await sourceFetch(url, signal);
        if (new URL(page.url).origin !== new URL(url).origin)
          throw new Error("Report redirected to another origin");
        html = page.html;
        url = page.url;
        const why = `Anchor code execution unavailable (${error.message.slice(0, 160)}); page HTML fetched directly, so DOM boxes and rendered content are not observed`;
        limitation = `${why}; screenshot coordinates not observed`;
        try {
          bytes = await screenshotTool(key, session.id, url, {
            width: 1440,
            height: 900,
          });
          shotStatus = "inferred";
          limitation = `${why}; full-page screenshot from the fallback screenshot tool, whose final page URL could not be verified`;
        } catch (shotError) {
          signal?.throwIfAborted();
          if (!(shotError instanceof AnchorError)) throw shotError;
          limitation = `${why}; screenshot tool also failed (${shotError.message.slice(0, 160)})`;
        }
      }
      signal?.throwIfAborted();
      if (bytes && bytes.byteLength < 1_900_000)
        screenshot = bytes.buffer as ArrayBuffer;
      else if (bytes)
        limitation =
          "Screenshot exceeded the run's 1.9 MB blob limit; screenshot coordinates not observed";
    } finally {
      signal?.removeEventListener("abort", abort);
      await close();
    }
  } else {
    const capture = await sourceFetch(url, signal);
    html = capture.html;
    url = capture.url;
  }
  signal?.throwIfAborted();
  const capturedAt = new Date().toISOString();
  const hash = await sha256(html);
  const evidence: Evidence[] = [
    {
      id: "ev_report_html",
      kind: "html",
      page: new URL(url).pathname,
      tool,
      status: "observed",
      capturedAt,
      hash,
      limits: "Report HTML; raw character offsets are retained per figure",
      summary: "Captured report source",
      path: "evidence/ev_report_html.html",
    },
    {
      id: "ev_report_screen",
      kind: "screenshot",
      page: new URL(url).pathname,
      tool: "anchor",
      status: screenshot ? shotStatus : "not_observed",
      capturedAt,
      hash: screenshot ? await sha256(screenshot) : "",
      limits: limitation,
      summary: screenshot
        ? boxes.length
          ? "Report screenshot with source regions"
          : "Report screenshot without source regions"
        : "Report screenshot not observed",
    },
  ];
  const blobs: Record<string, string | ArrayBuffer> = { ev_report_html: html };
  if (screenshot) blobs.ev_report_screen = screenshot;
  return {
    article: { html, url, capturedAt, hash },
    evidence,
    blobs,
    boxes,
    pageWidth,
    pageHeight,
  };
}

export function attachRegions(
  figures: ReportFigure[],
  capture: Pick<
    Awaited<ReturnType<typeof captureReport>>,
    "boxes" | "pageWidth" | "pageHeight"
  >,
  sourceUrls: Map<string, string>,
) {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  for (const f of figures) {
    const box = capture.boxes.find((b) =>
      f.sourceId === "article"
        ? normalize(b.text) === normalize(f.quote)
        : b.iframe &&
          b.text.replace(/&amp;/g, "&") === sourceUrls.get(f.sourceId),
    );
    if (!box) continue;
    f.location.screenshot = {
      evidenceId: "ev_report_screen",
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      pageWidth: capture.pageWidth,
      pageHeight: capture.pageHeight,
    };
  }
}
