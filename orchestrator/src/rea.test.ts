import { afterEach, describe, expect, it, vi } from "vitest";
import { Daytona } from "./daytona";
import { type Env, USER_AGENT } from "./types";
import {
  fetchBundles,
  fetchPageHtml,
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
  it.each(["&amp;", "&AMP;", "&#38;", "&#x26;"])(
    "uses real attributes and the first base href, decoding %s once",
    (entity) => {
      expect(
        scriptUrls(
          `<!-- <script src="fake.js"></script><base href="/wrong/"> -->
        <script src="main.js?x=1${entity}y=2" data-src="wrong.js"></script>
        <link rel="MODULEPRELOAD alternate" href="extra.mjs" data-href="wrong.mjs">
        <script data-src="unused.js"></script><link data-rel="modulepreload" href="unused.mjs">
        <base data-href="/wrong/"><base href="../assets/"><base href="/wrong/">
        <script src="once.js?x=1&amp;amp;y=2"></script>`,
          "https://site.example/docs/",
        ),
      ).toEqual([
        "https://site.example/assets/main.js?x=1&y=2",
        "https://site.example/assets/extra.mjs",
        "https://site.example/assets/once.js?x=1&amp;y=2",
      ]);
    },
  );
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
    sb.exec = async () => {
      stop.abort(new Error("run stopped"));
      throw stop.signal.reason;
    };
    await expect(
      reaInspect(sb, html, "https://site.example/", {}, stop.signal),
    ).rejects.toThrow("run stopped");
    expect(sb.removed).toEqual(["sb1"]);
  });

  it("sends the Reversy User-Agent on page and bundle fetches", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response("ok", { headers: { "content-type": "text/html" } }),
      );
    await fetchPageHtml("https://site.example/", {
      origin: "https://site.example",
      paths: ["/"],
    });
    await fetchBundles(["https://site.example/a.js"]);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [, init] of spy.mock.calls)
      expect(init?.headers).toEqual({ "User-Agent": USER_AGENT });
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
    expect(create).toHaveBeenCalledWith(
      {
        snapshot: "s",
        autoStopInterval: 5,
        autoDeleteInterval: 0,
      },
      undefined,
    );
  });
});

describe("REA sandbox ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const client = () =>
    new Daytona({
      DAYTONA_API_URL: "https://daytona.example",
      DAYTONA_API_KEY: "test",
    } as Env);

  it("interrupts stalled allocation and reports unknown cleanup ownership", async () => {
    const stop = new AbortController();
    let allocated!: () => void;
    const started = new Promise<void>((resolve) => {
      allocated = resolve;
    });
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        if (String(url) === "https://site.example/main.js")
          return new Response("fetch('/api/x')");
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
          allocated();
        });
      });
    const result = reaInspect(
      client(),
      '<script src="main.js"></script>',
      "https://site.example/",
      {},
      stop.signal,
    );
    const rejected = expect(result).rejects.toThrow(
      "Sandbox allocation unconfirmed",
    );
    await started;
    stop.abort();
    await rejected;
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(0);
  });

  it("bounds allocation even without a cancellation signal", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("Timed out", "TimeoutError")),
        ms,
      );
      return controller.signal;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const result = client().create({});
    const rejected = expect(result).rejects.toThrow(
      "Sandbox allocation unconfirmed",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
  });

  it.each(["network", "missing ID", "server error"])(
    "reports unconfirmed allocation after %s",
    async (failure) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (failure === "network") throw new TypeError("connection lost");
        return failure === "server error"
          ? new Response("error", { status: 503 })
          : Response.json({});
      });
      await expect(client().create({})).rejects.toThrow(
        "Sandbox allocation unconfirmed",
      );
    },
  );

  it("keeps a definitive allocation refusal as not observed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url) === "https://site.example/main.js"
        ? new Response("fetch('/api/x')")
        : new Response("quota exceeded", { status: 429 }),
    );
    expect(
      (
        await reaInspect(
          client(),
          '<script src="main.js"></script>',
          "https://site.example/",
          {},
        )
      )[0],
    ).toMatchObject({
      status: "not_observed",
      limits: expect.stringContaining("quota exceeded"),
    });
  });

  it.each(["error", "build_failed", "timeout"])(
    "deletes allocated sandboxes after startup %s",
    async (state) => {
      vi.useFakeTimers();
      const calls: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (init?.method === "POST") return Response.json({ id: "allocated" });
        if (init?.method === "DELETE") return new Response("");
        return Response.json({ id: "allocated", state });
      });
      const result = client()
        .create({})
        .catch((error: Error) => error);
      await vi.runAllTimersAsync();
      expect(await result).toBeInstanceOf(Error);
      expect(calls.at(-1)).toBe(
        "DELETE https://daytona.example/sandbox/allocated",
      );
    },
  );

  it.each(["allocation", "poll", "upload", "scan"])(
    "cancels during %s and confirms deletion",
    async (stage) => {
      const stop = new AbortController();
      const reason = new Error("stopped");
      const calls: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const path = String(url);
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "https://site.example/main.js")
          return new Response("fetch('/api/x')");
        if (init?.method === "DELETE") return new Response("");
        if (path === "https://daytona.example/sandbox") {
          if (stage === "allocation") stop.abort(reason);
          return Response.json({ id: "allocated" });
        }
        if (path.endsWith("toolbox-proxy-url"))
          return Response.json({ url: "https://toolbox.example" });
        const blocked =
          (stage === "poll" && path.endsWith("/sandbox/allocated")) ||
          (stage === "upload" && path.includes("/files/upload")) ||
          (stage === "scan" && path.endsWith("/process/execute"));
        if (blocked) {
          expect(init?.signal).toBe(stop.signal);
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
            stop.abort(reason);
          });
        }
        return Response.json({ id: "allocated", state: "started" });
      });
      await expect(
        reaInspect(
          client(),
          '<script src="main.js"></script>',
          "https://site.example/",
          {},
          stop.signal,
        ),
      ).rejects.toBe(reason);
      expect(calls.at(-1)).toBe(
        "DELETE https://daytona.example/sandbox/allocated",
      );
      expect(calls.filter((call) => call.startsWith("DELETE"))).toHaveLength(1);
    },
  );

  it.each(["startup", "scan"])(
    "propagates unconfirmed cleanup after %s",
    async (stage) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const path = String(url);
        if (path === "https://site.example/main.js")
          return new Response("fetch('/api/x')");
        if (init?.method === "DELETE")
          return new Response("unavailable", { status: 503 });
        if (path === "https://daytona.example/sandbox")
          return Response.json({ id: "allocated" });
        if (path.endsWith("toolbox-proxy-url"))
          return Response.json({ url: "https://toolbox.example" });
        if (path.endsWith("/process/execute"))
          return Response.json({ exitCode: 0, result: '{"findings":[]}' });
        return Response.json({
          id: "allocated",
          state: stage === "startup" ? "error" : "started",
        });
      });
      await expect(
        reaInspect(
          client(),
          '<script src="main.js"></script>',
          "https://site.example/",
          {},
        ),
      ).rejects.toThrow("Sandbox allocated cleanup unconfirmed");
    },
  );
});

describe("fetchPageHtml", () => {
  afterEach(() => vi.restoreAllMocks());
  const scope = { origin: "https://site.example", paths: ["/", "/home"] };

  it("returns the HTML and the final URL after approved redirects", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url) === "https://site.example/"
        ? new Response(null, {
            status: 302,
            headers: { location: "/home" },
          })
        : new Response("<html></html>", {
            headers: { "content-type": "text/html" },
          }),
    );
    expect(await fetchPageHtml("https://site.example/", scope)).toEqual({
      html: "<html></html>",
      url: "https://site.example/home",
    });
  });

  it.each([
    "https://login.example/sso",
    "/login",
    "/account?view=private",
    "/account",
  ])(
    "refuses an out-of-scope redirect to %s without requesting it",
    async (location) => {
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location },
        }),
      );
      await expect(
        fetchPageHtml("https://site.example/account?view=public", {
          origin: scope.origin,
          paths: ["/account?view=public"],
        }),
      ).rejects.toThrow("outside the approved scope");
      expect(spy).toHaveBeenCalledOnce();
    },
  );

  it("refuses an unapproved initial URL without requesting it", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(
      fetchPageHtml("https://site.example/login", scope),
    ).rejects.toThrow("outside the approved scope");
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts a trailing-slash redirect preserving an approved query", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/account/?view=public" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        }),
      );
    expect(
      await fetchPageHtml("https://site.example/account?view=public", {
        origin: scope.origin,
        paths: ["/account?view=public"],
      }),
    ).toEqual({
      html: "<html></html>",
      url: "https://site.example/account/?view=public",
    });
  });

  it.each(["text/html; charset=utf-8", "Application/XHTML+XML; charset=UTF-8"])(
    "accepts HTML with media type %s",
    async (contentType) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("<html></html>", {
          headers: { "content-type": contentType },
        }),
      );
      expect(await fetchPageHtml("https://site.example/", scope)).toEqual({
        html: "<html></html>",
        url: "https://site.example/",
      });
    },
  );

  it.each(["application/json", "text/plain", "text/html-unknown", null])(
    "rejects a non-HTML response with media type %s",
    async (contentType) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          new TextEncoder().encode('<script src="/preview.js"></script>'),
          {
            headers: contentType ? { "content-type": contentType } : {},
          },
        ),
      );
      await expect(
        fetchPageHtml("https://site.example/", scope),
      ).rejects.toThrow("page response is not HTML");
    },
  );

  it("rejects failed responses and bodies over the cap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("no", { status: 500 }),
    );
    await expect(fetchPageHtml("https://site.example/", scope)).rejects.toThrow(
      "HTTP 500",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array(3_000_000)),
    );
    await expect(fetchPageHtml("https://site.example/", scope)).rejects.toThrow(
      "over the size cap",
    );
  });
});
