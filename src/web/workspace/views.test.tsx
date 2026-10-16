import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CanvasEvidence } from "../../shared/workspace";
import { BuildView } from "./BuildView";
import { ChatPanel } from "./ChatPanel";
import { SpecView } from "./SpecView";

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
        onSaveToken={noop}
      />,
    );
    expect(html).toContain("Not found.");
    expect(html).toContain("Check the run ID or start a new session.");
    expect(html).not.toContain("Reconnecting.");
  });

  it("asks for a brief with Send brief disabled while empty", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        entries={[]}
        pending={false}
        onSend={noop}
        onRetry={noop}
        onSaveToken={noop}
      />,
    );
    expect(html).toContain("What would you like to make yours?");
    expect(html).toMatch(
      /<button type="submit"[^>]*disabled=""[^>]*>Send brief/,
    );
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
        onSaveToken={noop}
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
