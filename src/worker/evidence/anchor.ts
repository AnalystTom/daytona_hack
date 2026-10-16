import { viewports } from "../../shared/evidence";

// Anchor Browser REST API v1 (https://docs.anchorbrowser.io, OpenAPI 1.0.0 as of 2026-10-16).
const api = "https://api.anchorbrowser.io";

export class AnchorError extends Error {}

async function call(apiKey: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { "anchor-api-key": apiKey, "content-type": "application/json" },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new AnchorError(
      `Anchor ${init.method ?? "GET"} ${path.split("?")[0]} failed with ${response.status}: ${detail}`,
    );
  }
  return response;
}

export interface AnchorSession {
  id: string;
  liveViewUrl: string;
}

export async function createSession(
  apiKey: string,
  options: { recording: boolean; signInUrl?: string },
): Promise<AnchorSession> {
  const signIn = options.signInUrl !== undefined;
  const response = await call(apiKey, "/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      session: {
        initial_url: options.signInUrl,
        recording: { active: options.recording },
        // A sign-in session waits for the user to type their own credentials.
        timeout: signIn
          ? { max_duration: 30, idle_timeout: 15 }
          : { max_duration: 20, idle_timeout: 5 },
        live_view: { read_only: !signIn, one_time_url: signIn },
      },
      browser: {
        viewport: viewports.desktop,
        sensitive_data_mask: { active: true },
      },
    }),
  });
  const { data } = (await response.json()) as {
    data: { id: string; live_view_url: string };
  };
  return { id: data.id, liveViewUrl: data.live_view_url };
}

export async function endSession(apiKey: string, sessionId: string) {
  await call(apiKey, `/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

// Runs a snippet (an async function body with `page` injected) and returns its parsed result.
export async function runSnippet<T>(
  apiKey: string,
  sessionId: string,
  code: string,
): Promise<T> {
  const response = await call(
    apiKey,
    `/v1/tools/execute-code?sessionId=${encodeURIComponent(sessionId)}`,
    { method: "POST", body: JSON.stringify({ code }) },
  );
  const result = (await response.json()) as {
    success: boolean;
    message: string;
    output?: string;
    error?: string;
  };
  if (!result.success || result.output === undefined) {
    throw new AnchorError(
      `Anchor snippet failed: ${result.error ?? result.message}`,
    );
  }
  return JSON.parse(result.output) as T;
}

const maxRecordingBytes = 25_000_000;

// The session's primary recording as MP4 bytes, or null when Anchor has none ready.
export async function primaryRecording(
  apiKey: string,
  sessionId: string,
): Promise<Uint8Array | null> {
  const id = encodeURIComponent(sessionId);
  const list = await fetch(`${api}/v1/sessions/${id}/recordings`, {
    headers: { "anchor-api-key": apiKey },
  });
  if (list.status === 404) return null;
  if (!list.ok) {
    throw new AnchorError(
      `Anchor recordings lookup failed with ${list.status}`,
    );
  }
  const { data } = (await list.json()) as {
    data?: { items?: { is_primary?: boolean; size?: number }[] };
  };
  const primary =
    data?.items?.find((item) => item.is_primary) ?? data?.items?.[0];
  if (!primary) return null;
  // The file is held in memory and base64-encoded for SurrealDB, within a 128 MB Worker.
  const checkSize = (bytes: number) => {
    if (bytes > maxRecordingBytes) {
      throw new AnchorError(
        `Recording is ${Math.round(bytes / 1e6)} MB, over the ${maxRecordingBytes / 1e6} MB storage limit`,
      );
    }
  };
  checkSize(primary.size ?? 0);
  const file = await call(
    apiKey,
    `/v1/sessions/${id}/recordings/primary/fetch`,
  );
  checkSize(Number(file.headers.get("content-length") ?? 0));
  const video = new Uint8Array(await file.arrayBuffer());
  checkSize(video.byteLength);
  return video;
}

export interface PageFacts {
  finalUrl: string;
  html?: string;
  styles?: unknown;
  assets?: unknown;
  network?: unknown;
}

// Snippets run inside Anchor's sandbox, so they are plain JavaScript strings.
// Parameters are embedded with JSON.stringify, which yields safe literals.

export function navigateSnippet(url: string, origin: string, full: boolean) {
  return `
const params = ${JSON.stringify({ url, origin, full, viewport: viewports.desktop })};
const network = [];
const pending = [];
const shape = (value, depth) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length && depth < 4 ? [shape(value[0], depth + 1)] : [];
  if (typeof value === "object") {
    if (depth >= 4) return "object";
    const out = {};
    for (const key of Object.keys(value).slice(0, 50)) out[key] = shape(value[key], depth + 1);
    return out;
  }
  return typeof value;
};
const onResponse = (response) => {
  if (network.length >= 500) return;
  const request = response.request();
  const entry = {
    url: response.url(),
    method: request.method(),
    status: response.status(),
    resourceType: request.resourceType(),
    contentType: response.headers()["content-type"] || null,
  };
  network.push(entry);
  const json = (entry.contentType || "").includes("json");
  if (json && (entry.resourceType === "xhr" || entry.resourceType === "fetch")) {
    pending.push(response.json().then((body) => { entry.responseShape = shape(body, 0); }, () => {}));
  }
};
await page.setViewportSize(params.viewport);
if (params.full) page.on("response", onResponse);
try {
  await page.goto(params.url, { waitUntil: "load", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
} finally {
  if (params.full) page.off("response", onResponse);
}
await Promise.allSettled(pending);
const finalUrl = page.url();
if (!params.full || new URL(finalUrl).origin !== params.origin) return { finalUrl };
const styles = await page.evaluate(() => {
  const counts = { colors: {}, fontFamilies: {}, fontSizes: {}, fontWeights: {}, lineHeights: {}, spacing: {}, radii: {} };
  const skip = new Set(["", "0px", "normal", "none", "auto", "rgba(0, 0, 0, 0)"]);
  const bump = (bucket, value) => { if (!skip.has(value)) bucket[value] = (bucket[value] || 0) + 1; };
  const elements = Array.from(document.querySelectorAll("body, body *")).slice(0, 5000);
  for (const element of elements) {
    const s = getComputedStyle(element);
    bump(counts.colors, s.color);
    bump(counts.colors, s.backgroundColor);
    if (s.borderTopWidth !== "0px") bump(counts.colors, s.borderTopColor);
    bump(counts.fontFamilies, s.fontFamily);
    bump(counts.fontSizes, s.fontSize);
    bump(counts.fontWeights, s.fontWeight);
    bump(counts.lineHeights, s.lineHeight);
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      bump(counts.spacing, s["padding" + side]);
      bump(counts.spacing, s["margin" + side]);
    }
    bump(counts.spacing, s.rowGap);
    bump(counts.spacing, s.columnGap);
    bump(counts.radii, s.borderRadius);
  }
  const top = (bucket) => Object.entries(bucket).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([value, count]) => ({ value, count }));
  const tokens = {};
  for (const [name, bucket] of Object.entries(counts)) tokens[name] = top(bucket);
  const customProperties = {};
  let unreadableStylesheets = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try { rules = sheet.cssRules; } catch { unreadableStylesheets++; continue; }
    for (const rule of Array.from(rules)) {
      if (rule.selectorText !== ":root") continue;
      for (const name of Array.from(rule.style)) {
        if (name.startsWith("--")) customProperties[name] = rule.style.getPropertyValue(name).trim();
      }
    }
  }
  return { elementsSampled: elements.length, tokens, customProperties, unreadableStylesheets };
});
const pageAssets = await page.evaluate(() => ({
  images: Array.from(document.images).slice(0, 300).map((img) => ({
    src: img.currentSrc || img.src, alt: img.alt, width: img.naturalWidth, height: img.naturalHeight,
  })),
  icons: Array.from(document.querySelectorAll("link[rel~='icon'], link[rel='apple-touch-icon']")).map((link) => link.href),
  fonts: Array.from(document.fonts).map((font) => ({ family: font.family, weight: font.weight, style: font.style, status: font.status })),
}));
const loaded = network
  .filter((entry) => ["image", "font", "media", "stylesheet"].includes(entry.resourceType))
  .map((entry) => ({ url: entry.url, type: entry.resourceType, contentType: entry.contentType }));
return {
  finalUrl: page.url(),
  html: await page.content(),
  styles,
  assets: { ...pageAssets, loaded },
  network,
};
`;
}

export function screenshotSnippet(viewport: { width: number; height: number }) {
  return `
const viewport = ${JSON.stringify(viewport)};
const current = page.viewportSize();
if (!current || current.width !== viewport.width) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(1000);
}
const png = await page.screenshot({ fullPage: true, type: "png" });
return { finalUrl: page.url(), png: Buffer.from(png).toString("base64") };
`;
}
