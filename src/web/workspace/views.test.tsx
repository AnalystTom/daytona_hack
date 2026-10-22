import { renderToStaticMarkup } from "react-dom/server";
import { Parser } from "htmlparser2";
import { describe, expect, it, vi } from "vitest";
import type { CanvasEvidence } from "../../shared/workspace";
import { BuildView } from "./BuildView";
import { ChatPanel } from "./ChatPanel";
import { PreviewView } from "./PreviewView";
import { SpecView } from "./SpecView";
import { runView } from "./orchestrator";

const noop = () => {};

const screenshot: CanvasEvidence = {
  id: "ev_1",
  kind: "screenshot",
  label: "observed",
  pageOrState: "/ (desktop)",
  tool: "anchor",
  capturedAt: "2026-10-16T12:00:00Z",
  contentHash: "sha256:abc",
  limitations: [],
  src: "/evidence/ev_1.png",
};

describe("SpecView", () => {
  it("shows an inferred screenshot event on the canvas with its label", () => {
    const view = runView("r1", [
      {
        seq: 1,
        ts: screenshot.capturedAt,
        type: "evidence",
        data: {
          id: screenshot.id,
          page: screenshot.pageOrState,
          kind: "screenshot",
          tool: screenshot.tool,
          status: "inferred",
          capturedAt: screenshot.capturedAt,
          hash: screenshot.contentHash,
          limits: "Final URL could not be verified",
          url: `/runs/r1/evidence/${screenshot.id}`,
        },
      },
    ]);
    expect(view.evidence[0]).toMatchObject({
      label: "inferred",
      src: `/api/v1/runs/r1/evidence/${screenshot.id}`,
    });
    const html = renderToStaticMarkup(
      <SpecView canvas={{ evidence: view.evidence }} />,
    );
    expect(html).toContain("<img");
    expect(html).toContain(`alt="Screenshot of ${screenshot.pageOrState}"`);
    expect(html).toContain("Inferred");
    expect(html).not.toContain("Not observed");
  });

  it("shows only the empty state before anything exists", () => {
    const html = renderToStaticMarkup(<SpecView canvas={{ evidence: [] }} />);
    expect(html).toContain("Your work starts here");
    expect(html).not.toContain("Draft spec");
    expect(html).not.toContain("Video evidence");
  });

  it("marks unagreed spec fields as not confirmed", () => {
    const html = renderToStaticMarkup(
      <SpecView canvas={{ draftSpec: { status: "draft" }, evidence: [] }} />,
    );
    expect(html.match(/Not confirmed yet/g)).toHaveLength(3);
    expect(html).toContain("No recording yet");
    expect(html).not.toContain("Target screenshot");
  });

  it("renders agreed fields and screenshots linked to their page", () => {
    const html = renderToStaticMarkup(
      <SpecView
        canvas={{
          draftSpec: {
            status: "draft",
            url: "https://www.daytona.io/",
            pagesAndFlows: ["Landing page"],
          },
          evidence: [screenshot],
        }}
      />,
    );
    expect(html).toContain('href="https://www.daytona.io/"');
    expect(html).toContain("<li>Landing page</li>");
    expect(html.match(/Not confirmed yet/g)).toHaveLength(1);
    expect(html).toContain('src="/evidence/ev_1.png"');
    expect(html).toContain("/ (desktop)");
  });

  it("says where the entered URL redirects and why a screenshot is missing", () => {
    const html = renderToStaticMarkup(
      <SpecView
        canvas={{
          draftSpec: {
            status: "draft",
            url: "https://www.wikipedia.org/",
            redirectedFrom: "https://www.wikipedia.com/",
          },
          evidence: [
            {
              ...screenshot,
              label: "not_observed",
              limitations: [
                "Redirected to https://login.example.com/, outside the approved scope; capture stopped for this page.",
              ],
              src: undefined,
            },
          ],
        }}
      />,
    );
    expect(html).toContain(
      "You entered https://www.wikipedia.com/; it redirects to https://www.wikipedia.org/.",
    );
    expect(html).toContain(
      "The site redirected to https://login.example.com/, outside the pages approved for this run; that is usually a sign-in page.",
    );
    expect(html).not.toContain("<img");
  });

  it("never puts a run recording's token-guarded URL straight into the video", () => {
    const recording: CanvasEvidence = {
      ...screenshot,
      id: "ev_2",
      kind: "recording",
      src: "/api/v1/runs/r1/evidence/ev_2",
    };
    const html = renderToStaticMarkup(
      <SpecView canvas={{ evidence: [recording] }} />,
    );
    expect(html).toContain("<video");
    // Loaded as a blob with the operator token once mounted.
    expect(html).not.toContain('src="/api/v1/runs/r1/evidence/ev_2"');
  });

  it("keeps twelve findings visible and discloses every retained finding", () => {
    const evidence = Array.from({ length: 60 }, (_, i) => ({
      ...screenshot,
      id: `code-${i}`,
      kind: "bundle" as const,
      tool: "rea",
      summary: `Finding ${i + 1}`,
      locator: `main.js:${i + 1}:0`,
    }));
    const html = renderToStaticMarkup(<SpecView canvas={{ evidence }} />);
    let collapsed = 0;
    let disclosed = 0;
    let inDetails = false;
    new Parser({
      onopentag(name, attrs) {
        if (name === "details") {
          expect(attrs.open).toBeUndefined();
          inDetails = true;
        }
        if (name === "li") {
          if (inDetails) disclosed++;
          else collapsed++;
        }
      },
      onclosetag(name) {
        if (name === "details") inDetails = false;
      },
    }).end(html);
    expect(collapsed).toBe(12);
    expect(disclosed).toBe(48);
    expect(html).toContain("Show all 60 findings");
    expect(html).toContain("main.js:60:0");
  });

  it("shows REA code evidence beside the spec with locators, or why it is missing", () => {
    const code = (data: Record<string, unknown>, seq: number) => ({
      seq,
      ts: screenshot.capturedAt,
      type: "evidence",
      data: {
        page: "/",
        kind: "code",
        tool: "rea",
        capturedAt: screenshot.capturedAt,
        limits: "Static analysis only",
        ...data,
      },
    });
    const found = runView("r1", [
      code(
        {
          id: "ev_004",
          status: "observed",
          hash: "sha256:b1",
          locator: "b1.mjs:12:4",
          summary:
            "API call POST /api/signup in https://cdn.example.com/b1.mjs",
        },
        1,
      ),
      code(
        {
          id: "ev_005",
          status: "inferred",
          hash: "sha256:b1",
          locator: "b1.mjs:40:1",
          summary: "Route /pricing in https://cdn.example.com/b1.mjs",
        },
        2,
      ),
    ]);
    expect(found.evidence[0]).toMatchObject({
      kind: "bundle",
      locator: "b1.mjs:12:4",
      contentHash: "sha256:b1",
    });
    const html = renderToStaticMarkup(
      <SpecView canvas={{ evidence: found.evidence }} />,
    );
    expect(html).toContain("Code evidence");
    expect(html).toContain("API call POST /api/signup");
    expect(html).toContain("b1.mjs:12:4");
    expect(html).toContain("Inferred");

    const missing = runView("r1", [
      code(
        {
          id: "ev_004",
          status: "not_observed",
          hash: "",
          limits: "REA failed: timed out",
          summary: "REA analysis of 2 script bundles not run",
        },
        1,
      ),
    ]);
    expect(
      renderToStaticMarkup(
        <SpecView canvas={{ evidence: missing.evidence }} />,
      ),
    ).toContain(
      "REA analysis of 2 script bundles not run: REA failed: timed out",
    );
  });
});

describe("BuildView", () => {
  it("renders the named kanban mount with the no-build state", () => {
    const html = renderToStaticMarkup(<BuildView />);
    expect(html).toContain('data-mount="kanban"');
    expect(html).toContain("No build started");
  });
});

describe("ChatPanel", () => {
  it("shows the missing-run notice with recovery guidance", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        entries={[
          {
            kind: "notice",
            id: "events-not-found",
            error: "not_found",
            detail:
              "Run missing not found. Check the run ID or start a new session.",
          },
        ]}
        pending={false}
        onSend={noop}
        onRetry={noop}
      />,
    );
    expect(html).toContain("Not found.");
    expect(html).toContain("Check the run ID or start a new session.");
    expect(html).not.toContain("Reconnecting.");
  });

  it("asks for a brief with Send brief disabled while empty", () => {
    const html = renderToStaticMarkup(
      <ChatPanel entries={[]} pending={false} onSend={noop} onRetry={noop} />,
    );
    expect(html).toContain("What would you like to make yours?");
    expect(html).toMatch(
      /<button type="submit"[^>]*disabled=""[^>]*>Send brief/,
    );
  });

  it("renders a protected sign-in document in a separate tab with no submitted message", () => {
    const onSend = vi.fn();
    const onRetry = vi.fn();
    const html = renderToStaticMarkup(
      <ChatPanel
        entries={[
          { kind: "agent", id: "reply", text: "Keep the current hero" },
          {
            kind: "user",
            id: "brief",
            text: "copy https://example.com",
            delivery: "failed",
          },
          {
            kind: "notice",
            id: "auth",
            error: "access_required",
            detail: "Sign in in a new tab, then return here and try again.",
          },
        ]}
        pending={false}
        onSend={onSend}
        onRetry={onRetry}
      />,
    );
    expect(html).toContain(
      'href="/start" target="_blank" rel="noopener noreferrer"',
    );
    expect(html).toContain("Sign in in a new tab");
    expect(html).toContain("Keep the current hero");
    expect(html).toContain("copy https://example.com");
    expect(html).toContain("Try again");
    expect(html).not.toContain('id="operator-token"');
    expect(onSend).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("shows a sent brief, a failed delivery and inline states", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        entries={[
          {
            kind: "user",
            id: "1",
            text: "copy daytona.io",
            delivery: "failed",
          },
          {
            kind: "notice",
            id: "2",
            error: "not_connected",
            detail: "The run service is not available yet.",
          },
          { kind: "reconnecting", id: "3" },
          {
            kind: "sign_in",
            id: "4",
            page: "Dashboard",
            signInUrl: "javascript:alert(1)",
          },
        ]}
        pending={false}
        onSend={noop}
        onRetry={noop}
      />,
    );
    expect(html).toContain("copy daytona.io");
    expect(html).toContain("Not delivered.");
    expect(html).toContain("Not connected.");
    expect(html).toContain("Reconnecting.");
    expect(html).toContain("Dashboard needs an account.");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Send brief");
  });
});

describe("PreviewView", () => {
  it("waits for an authenticated preview link before embedding anything", () => {
    const html = renderToStaticMarkup(
      <PreviewView
        runId="r1"
        onRefused={noop}
        variants={[]}
        onMakeVariants={noop}
        onPromote={noop}
      />,
    );
    expect(html).toContain("Opening the preview");
    expect(html).not.toContain("<iframe");
  });
});
