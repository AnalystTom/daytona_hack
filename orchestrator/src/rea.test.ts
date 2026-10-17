import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchBundles,
  type ReaSandbox,
  type ReaScan,
  reaEvidence,
  reaInspect,
  scriptUrls,
} from "./rea";

const sha = "8b042780395cf27d1ffccdcdc0eb04635bc3f959a8286c85a1eaecefb7f9b0aa";
const files = { "0.js": "https://example.com/assets/main.js?v=secret" };

describe("reaEvidence", () => {
  it("turns each finding into code evidence with hash, locator and limits", () => {
    const scan: ReaScan = {
      findings: [
        {
          kind: "api",
          value: "/api/users",
          file: "0.js",
          sha256: sha,
          locator: "0.js:2:57",
          state: "observed",
          mechanism: "call:fetch",
        },
        {
          kind: "module",
          value: "0.js",
          file: "0.js",
          sha256: sha,
          locator: "0.js:1:0",
          state: "inferred",
          format: "esm",
          exports: ["App"],
        },
      ],
      omitted: 4,
      truncated: false,
      limitations: ["parsed as inert text"],
    };
    const [api, mod] = reaEvidence(scan, files);
    expect(api).toMatchObject({
      kind: "code",
      tool: "rea",
      status: "observed",
      hash: sha,
      locator: "0.js:2:57",
      summary:
        "API call /api/users (via call:fetch) in https://example.com/assets/main.js",
    });
    expect(api?.limits).toContain("not executed or observed at runtime");
    expect(api?.limits).toContain("4 further findings omitted");
    expect(api?.limits).toContain("parsed as inert text");
    expect(mod).toMatchObject({
      status: "inferred",
      summary:
        "Module 0.js (esm, exports App) in https://example.com/assets/main.js",
    });
  });

  it("records not_observed with the reason when REA fails or finds nothing", () => {
    const [failed] = reaEvidence(
      { error: "REA did not finish within 120s" },
      files,
    );
    expect(failed).toMatchObject({
      kind: "code",
      tool: "rea",
      status: "not_observed",
      limits: "REA failed: REA did not finish within 120s",
      summary: "REA analysis of 1 script bundles not run",
    });
    expect(reaEvidence(undefined, files)[0]?.status).toBe("not_observed");
    expect(
      reaEvidence(
        { findings: [], omitted: 0, truncated: true, limitations: [] },
        files,
      )[0],
    ).toMatchObject({
      status: "not_observed",
      limits: expect.stringContaining("truncated"),
    });
  });
});

describe("scriptUrls", () => {
  it("lists script and module preload bundles, absolute and deduplicated", () => {
    const html = `<script src="/a.js"></script><script type="module" src='https://cdn.example/b.mjs?x=1&amp;y=2'></script>
<script>inline()</script><script src="/a.js"></script><link rel="modulepreload" href="c.mjs"><link rel="stylesheet" href="s.css">
<script src="data:text/javascript,1"></script>`;
    expect(scriptUrls(html, "https://site.example/p/")).toEqual([
      "https://site.example/a.js",
      "https://cdn.example/b.mjs?x=1&y=2",
      "https://site.example/p/c.mjs",
    ]);
    expect(scriptUrls(html, "https://site.example/", 1)).toHaveLength(1);
  });
});

describe("reaInspect", () => {
  afterEach(() => vi.restoreAllMocks());
  const html =
    '<script src="/main.js"></script><script src="/gone.js"></script>';
  const sandbox = (result: string, exitCode = 0) => {
    const writes: string[] = [];
    const sb: ReaSandbox & { writes: string[]; removed: string[] } = {
      writes,
      removed: [],
      create: async () => ({ id: "sb1" }),
      remove: async (id) => void sb.removed.push(id),
      writeFile: async (_id, path) => void writes.push(path),
      exec: async () => ({ exitCode, result }),
    };
    return sb;
  };
  const serve = () =>
    vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        String(url).endsWith("/main.js")
          ? new Response("fetch('/api/x')")
          : new Response("", { status: 404 }),
      );

  it("scans fetched bundles in a throwaway sandbox and removes it", async () => {
    serve();
    const scan: ReaScan = {
      findings: [
        {
          kind: "api",
          value: "/api/x",
          file: "0.js",
          sha256: sha,
          locator: "0.js:1:0",
          state: "observed",
        },
      ],
      omitted: 0,
      truncated: false,
      limitations: [],
    };
    const sb = sandbox(`progress\n${JSON.stringify(scan)}\n`);
    const [item] = await reaInspect(sb, html, "https://site.example/", {});
    expect(sb.writes).toEqual(["/tmp/rea-bundles/0.js"]);
    expect(sb.removed).toEqual(["sb1"]);
    expect(item).toMatchObject({
      status: "observed",
      hash: sha,
      summary: "API call /api/x in https://site.example/main.js",
    });
    expect(item?.limits).toContain(
      "Skipped: https://site.example/gone.js (HTTP 404)",
    );
  });

  it("records not_observed when there is nothing to scan or the sandbox fails", async () => {
    expect(
      (
        await reaInspect(sandbox(""), "<p>hi</p>", "https://site.example/", {})
      )[0],
    ).toMatchObject({
      status: "not_observed",
      limits: "the page ships no external script bundles",
    });
    serve();
    const broken = sandbox("");
    broken.create = async () => {
      throw new Error("quota exceeded");
    };
    expect(
      (await reaInspect(broken, html, "https://site.example/", {}))[0],
    ).toMatchObject({
      status: "not_observed",
      limits: "REA sandbox failed: quota exceeded",
    });
    const crashed = sandbox("Segmentation fault", 139);
    const [item] = await reaInspect(crashed, html, "https://site.example/", {});
    expect(item?.limits).toContain("REA failed: scan exited 139");
    expect(crashed.removed).toEqual(["sb1"]);
  });

  it("stops waiting for the scan on abort and removes the sandbox", async () => {
    serve();
    const sb = sandbox("");
    const stop = new AbortController();
    sb.exec = () => {
      stop.abort(new Error("run stopped"));
      return new Promise(() => {}); // a scan that would run to its bound
    };
    await expect(
      reaInspect(sb, html, "https://site.example/", {}, stop.signal),
    ).rejects.toThrow("run stopped");
    expect(sb.removed).toEqual(["sb1"]);
  });

  it("skips bundles over the size cap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(4_000_001)),
    );
    const { files, skipped } = await fetchBundles([
      "https://site.example/big.js",
    ]);
    expect(files).toEqual({});
    expect(skipped).toEqual([
      "https://site.example/big.js (over the size cap)",
    ]);
  });
  it("refuses private hosts and private redirect hops, and stays inside the byte cap while streaming", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        const u = String(url);
        if (u.endsWith("/hop.js"))
          return new Response(null, {
            status: 302,
            headers: { location: "https://169.254.169.254/latest" },
          });
        if (u.endsWith("/ok.js")) return new Response("fetch('/api/x')");
        return new Response(new Uint8Array(5_000_000)); // no content-length
      });
    const { files, skipped } = await fetchBundles([
      "https://10.0.0.1/a.js",
      "http://site.example/b.js",
      "https://site.example/hop.js",
      "https://site.example/ok.js",
      "https://site.example/endless.js",
    ]);
    expect(Object.values(files)).toEqual(["https://site.example/ok.js"]);
    expect(skipped).toEqual([
      "https://10.0.0.1/a.js (The URL must point to a public host.)",
      "http://site.example/b.js (The URL must use https.)",
      "https://site.example/hop.js (The URL must point to a public host.)",
      "https://site.example/endless.js (over the size cap)",
    ]);
    expect(
      spy.mock.calls.every(([, init]) => init?.redirect === "manual"),
    ).toBe(true);
    expect(spy.mock.calls.map(([u]) => String(u))).not.toContain(
      "https://169.254.169.254/latest",
    );
  });

  it("removes the sandbox when writing or scanning fails", async () => {
    serve();
    const sb = sandbox("");
    sb.exec = async () => {
      throw new Error("toolbox down");
    };
    const [item] = await reaInspect(sb, html, "https://site.example/", {});
    expect(item).toMatchObject({ status: "not_observed" });
    expect(sb.removed).toEqual(["sb1"]);
  });

  it("creates the sandbox with no env and a short auto-delete backstop", async () => {
    serve();
    const sb = sandbox('{"findings":[],"omitted":0,"truncated":false}');
    const create = vi.spyOn(sb, "create");
    await reaInspect(sb, html, "https://site.example/", { snapshot: "s" });
    expect(create).toHaveBeenCalledWith({
      snapshot: "s",
      autoStopInterval: 5,
      autoDeleteInterval: 0,
    });
  });
});
