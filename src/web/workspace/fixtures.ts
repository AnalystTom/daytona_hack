import type { SpecCanvas } from "../../shared/workspace";
import type { ChatEntry } from "./chat";

// Fixture mode (/workspace?fixture=spec): sample data for design review, always shown under a banner.

const screenshotSvg = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800"><rect width="1280" height="800" fill="#1d1b22"/><text x="640" y="410" fill="#c4db9b" font-family="sans-serif" font-size="40" text-anchor="middle">Fixture screenshot</text></svg>`,
);

export type WorkspaceFixture = { canvas: SpecCanvas; entries: ChatEntry[] };

export const specFixture: WorkspaceFixture = {
  canvas: {
    draftSpec: { url: "https://www.daytona.io/", status: "draft" },
    evidence: [
      {
        id: "fixture_ev_1",
        kind: "screenshot",
        label: "observed",
        pageOrState: "/ (desktop)",
        tool: "fixture",
        capturedAt: "2026-10-16T12:00:00Z",
        contentHash: "fixture",
        limitations: ["Fixture image, not a capture"],
        src: `data:image/svg+xml,${screenshotSvg}`,
      },
    ],
  },
  entries: [
    {
      kind: "user",
      id: "fixture_1",
      text: "https://www.daytona.io/ copy this site",
      delivery: "sent",
    },
    {
      kind: "agent",
      id: "fixture_2",
      text: "Which pages and interactions should we include?",
    },
    {
      kind: "sign_in",
      id: "fixture_3",
      page: "Dashboard",
      signInUrl: "https://example.com/fixture-sign-in",
    },
    { kind: "reconnecting", id: "fixture_4" },
  ],
};
