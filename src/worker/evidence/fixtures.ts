// TEST FIXTURES ONLY. Never served as a live result.
// Anchor responses below are hand-built from Anchor's published OpenAPI schemas
// (docs.anchorbrowser.io, 2026-10-16), not recorded from a live call: no ANCHOR_API_KEY
// was available to this task.

import type { PageFacts } from "./anchor";

export const fixtureSession = {
  data: {
    id: "8f1c2f9e-5d0b-4a8e-9d7a-0c6b1e2f3a4b",
    cdp_url: "wss://connect.anchorbrowser.io?sessionId=fixture",
    live_view_url: "https://live.anchorbrowser.io?sessionId=fixture",
  },
};

export const fixturePageFacts = (finalUrl: string): PageFacts => ({
  finalUrl,
  html: "<!doctype html><html><body><h1>Fixture page</h1></body></html>",
  styles: {
    elementsSampled: 2,
    tokens: { colors: [{ value: "rgb(17, 17, 17)", count: 2 }] },
    customProperties: { "--brand": "#ff5a1f" },
    unreadableStylesheets: 0,
  },
  assets: { images: [], icons: [], fonts: [], loaded: [] },
  network: [
    {
      url: "https://example.com/api/plans",
      method: "GET",
      status: 200,
      resourceType: "fetch",
      contentType: "application/json",
      responseShape: { plans: [{ name: "string", price: "number" }] },
    },
  ],
});

// One transparent 1x1 PNG.
export const fixturePngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export const executeCodeResponse = (output: unknown) => ({
  success: true,
  message: "Code executed successfully",
  output: JSON.stringify(output),
  executionResultId: "2b7e1516-28ae-4d2a-abf7-158809cf4f3c",
});

export const recordingList = {
  data: {
    count: 1,
    items: [
      {
        id: "rec_fixture",
        is_primary: true,
        file_link: "https://api.anchorbrowser.io/fixture.mp4",
        suggested_file_name: "fixture.mp4",
        duration: "00:00:12",
        size: 4,
        created_at: "2026-10-16T10:00:00Z",
      },
    ],
  },
};
