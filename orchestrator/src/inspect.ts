// Inspector: captures evidence for in-scope pages. Site content is data, never instructions.
import { anchorScreenshot, pageHtml, sha256 } from "./services";
import type { Env, Evidence } from "./types";

export interface Capture {
  evidence: Evidence[];
  blobs: Record<string, ArrayBuffer | string>; // evidence id -> content, written to the sandbox evidence store
}

const now = () => new Date().toISOString();

export function routesFrom(html: string, base: string): string[] {
  const origin = new URL(base).origin;
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="([^"#?]+)"/g)) {
    try {
      const u = new URL(m[1], base);
      if (
        u.origin === origin &&
        !/\.(png|jpe?g|svg|webp|ico|css|js|xml|pdf|woff2?)$/i.test(u.pathname)
      )
        seen.add(u.pathname);
    } catch {}
  }
  return [...seen].slice(0, 40);
}

function tokensFrom(css: string) {
  const count = (re: RegExp) => {
    const m = new Map<string, number>();
    for (const x of css.matchAll(re))
      m.set(x[1].trim(), (m.get(x[1].trim()) || 0) + 1);
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([v, n]) => ({ value: v, uses: n }));
  };
  return {
    colors: count(/(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\))/g),
    fonts: count(/font-family:\s*([^;}]+)/g),
    radii: count(/border-radius:\s*([^;}]+)/g),
    fontSizes: count(/font-size:\s*([^;}]+)/g),
    customProperties: count(/(--[a-zA-Z0-9-]+):/g),
  };
}

export async function inspectPage(
  env: Env,
  url: string,
  startId: number,
  opts: { full: boolean },
): Promise<Capture> {
  const page = new URL(url).pathname;
  const evidence: Evidence[] = [];
  const blobs: Capture["blobs"] = {};
  let n = startId;
  const id = () => `ev_${String(n++).padStart(3, "0")}`;

  const viewports: [string, number, number][] = opts.full
    ? [
        ["desktop", 1440, 900],
        ["mobile", 390, 844],
      ]
    : [["desktop", 1440, 900]];
  for (const [name, w, h] of viewports) {
    const shot = await anchorScreenshot(env, url, w, h);
    const eid = id();
    if (shot) {
      blobs[eid] = shot;
      evidence.push({
        id: eid,
        page,
        kind: "screenshot",
        tool: "anchor",
        status: "observed",
        capturedAt: now(),
        hash: await sha256(shot),
        limits: `${name} ${w}px, full height, after load + 1.5s`,
        summary: `${name} screenshot of ${page}`,
        path: `evidence/${eid}.png`,
      });
    } else {
      evidence.push({
        id: eid,
        page,
        kind: "screenshot",
        tool: "anchor",
        status: "not_observed",
        capturedAt: now(),
        hash: "",
        limits: "Anchor not configured",
        summary: `No ${name} screenshot yet`,
      });
    }
  }

  const { html, tool } = await pageHtml(env, url);
  const hid = id();
  blobs[hid] = html;
  evidence.push({
    id: hid,
    page,
    kind: "html",
    tool,
    status: "observed",
    capturedAt: now(),
    hash: await sha256(html),
    limits:
      tool === "fetch"
        ? "server HTML only; client-rendered content may be missing"
        : "rendered HTML",
    summary: `HTML of ${page} (${Math.round(html.length / 1024)} KB)`,
    path: `evidence/${hid}.html`,
  });

  if (opts.full) {
    const cssUrls = [...html.matchAll(/<link[^>]+href="([^"]+\.css[^"]*)"/g)]
      .map((m) => new URL(m[1], url).toString())
      .slice(0, 6);
    let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1])
      .join("\n");
    for (const c of cssUrls) {
      try {
        css += "\n" + (await (await fetch(c)).text());
      } catch {}
    }
    const tid = id();
    const tokens = JSON.stringify(tokensFrom(css), null, 1);
    blobs[tid] = tokens;
    evidence.push({
      id: tid,
      page,
      kind: "styles",
      tool: "fetch",
      status: "inferred",
      capturedAt: now(),
      hash: await sha256(tokens),
      limits: "frequency of values in shipped CSS, not computed styles",
      summary: `Design tokens from ${cssUrls.length} stylesheets`,
      path: `evidence/${tid}.json`,
    });

    const assets = [
      ...html.matchAll(/<(?:img|source)[^>]+(?:src|srcset)="([^"\s]+)/g),
    ].map((m) => new URL(m[1], url).toString());
    const aid = id();
    const list = JSON.stringify([...new Set(assets)].slice(0, 80), null, 1);
    blobs[aid] = list;
    evidence.push({
      id: aid,
      page,
      kind: "assets",
      tool: "fetch",
      status: "observed",
      capturedAt: now(),
      hash: await sha256(list),
      limits: "img/source tags in HTML only",
      summary: `${assets.length} image assets`,
      path: `evidence/${aid}.json`,
    });
  }
  return { evidence, blobs };
}

/** Text the planner and workers can read: HTML stripped to structure and copy. */
export function outline(html: string, max = 12000): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>")
    .replace(/\s(class|style|data-[a-z-]+)="[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .slice(0, max);
}
