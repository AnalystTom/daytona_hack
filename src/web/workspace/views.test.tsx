import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CanvasEvidence } from "../../shared/workspace";
import { BuildView } from "./BuildView";
import { ChatPanel } from "./ChatPanel";
import { PreviewView } from "./PreviewView";
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
});

describe("BuildView", () => {
  it("renders the named kanban mount with the no-build state", () => {
    const html = renderToStaticMarkup(<BuildView />);
    expect(html).toContain('data-mount="kanban"');
    expect(html).toContain("No build started");
  });
});

describe("ChatPanel", () => {
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

describe("PreviewView", () => {
  const preview = (props: Partial<Parameters<typeof PreviewView>[0]>) =>
    renderToStaticMarkup(
      <PreviewView
        variants={[]}
        onMakeVariants={noop}
        onPromote={noop}
        {...props}
      />,
    );

  it("waits for the first merge", () => {
    expect(preview({})).toContain("No preview yet");
  });

  it("embeds the rebuild sandboxed, with deploy disabled and variants on offer once finished", () => {
    const building = preview({
      previewUrl: "https://3000-sb.daytona.works",
      phase: "building",
    });
    expect(building).toContain('src="https://3000-sb.daytona.works"');
    expect(building).toContain(
      'sandbox="allow-scripts allow-forms allow-same-origin"',
    );
    expect(building).toMatch(/<button[^>]*disabled=""[^>]*>Deploy live/);
    expect(building).toMatch(/disabled=""[^>]*>Make three variants/);
    const done = preview({
      previewUrl: "https://3000-sb.daytona.works",
      phase: "done",
    });
    expect(done).not.toMatch(/disabled=""[^>]*>Make three variants/);
  });

  it("lets a ready variant be promoted until one is", () => {
    const v = {
      title: "Bold hero",
      explanation: "Louder",
      pod: "copy" as const,
      previewUrl: "https://3001-sb.daytona.works",
    };
    const html = preview({
      previewUrl: "https://3000-sb.daytona.works",
      phase: "done",
      variants: [
        { ...v, id: "v1", status: "ready" },
        { ...v, id: "v2", status: "failed" },
      ],
    });
    expect(html).toContain("Copy of the merged rebuild");
    expect(html).toContain("Did not finish");
    expect(html.match(/Promote this variant/g)).toHaveLength(1);
    expect(html).not.toContain("Make three variants");
    const promoted = preview({
      previewUrl: "https://3000-sb.daytona.works",
      phase: "done",
      variants: [
        { ...v, id: "v1", status: "promoted" },
        { ...v, id: "v2", status: "ready" },
      ],
    });
    expect(promoted).toMatch(/disabled=""[^>]*>Promote this variant/);
  });
});
