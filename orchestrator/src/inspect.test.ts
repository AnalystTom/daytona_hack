import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backendFacts,
  inspectBackend,
  maxRedirects,
  resolveRedirects,
} from "./inspect";

afterEach(() => vi.restoreAllMocks());

describe("backend HTML evidence", () => {
  it.each([false, true])(
    "retains only HTML within the storage byte cap, oversized=%s",
    async (oversized) => {
      const html = oversized
        ? "界".repeat(640_000)
        : '<script src="main.js"></script>';
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
        String(url) === "https://site.example/docs/"
          ? new Response(html, { headers: { "content-type": "text/html" } })
          : new Response("", { status: 404 }),
      );
      const { evidence, blobs } = await inspectBackend(
        "https://site.example/docs/",
        1,
      );
      const document = evidence.find((item) => item.kind === "html");
      expect(document).toMatchObject({
        page: "/docs/",
        status: oversized ? "not_observed" : "observed",
      });
      if (!document) throw new Error("missing HTML evidence");
      if (oversized) {
        expect(blobs[document.id]).toBeUndefined();
        expect(document.path).toBeUndefined();
      } else {
        expect(blobs[document.id]).toBe(html);
        expect(document.path).toMatch(/\.html$/);
      }
    },
  );
});

describe("backend facts", () => {
  it.each(["&amp;", "&AMP;", "&#38;", "&#x26;"])(
    "decodes %s in HTML attributes while preserving raw script strings",
    (reference) => {
      const facts = backendFacts(
        `<SCRIPT SRC="/static/app.js?v=1${reference}lang=en"></SCRIPT>
<script src='/static/single.js?v=1${reference}lang=en'></script>
<script src=/static/unquoted.js?v=1${reference}lang=en></script>
<a href="/api/articles?id=1${reference}lang=en">Articles</a>
<a href='/api/single?id=1${reference}lang=en'>Single</a>
<a href=/api/unquoted?id=1${reference}lang=en>Unquoted</a>
<button onclick="fetch(&quot;/api/inline?id=1${reference}lang=en&quot;)">Load</button>
<script>fetch("/api/raw?id=1${reference}lang=en")</script>
<script type='application/ld+json'>{"url":"/api/json?id=1${reference}lang=en","items":[{"id":42}]}</script>`,
        "https://site.example/page",
      );
      expect(facts).toEqual({
        scripts: [
          "https://site.example/static/app.js?v=1&lang=en",
          "https://site.example/static/single.js?v=1&lang=en",
          "https://site.example/static/unquoted.js?v=1&lang=en",
        ],
        endpoints: [
          "https://site.example/api/articles?id=1&lang=en",
          "https://site.example/api/single?id=1&lang=en",
          "https://site.example/api/unquoted?id=1&lang=en",
          "https://site.example/api/inline?id=1&lang=en",
          `https://site.example/api/raw?id=1${reference}lang=en`,
          `https://site.example/api/json?id=1${reference}lang=en`,
        ],
        data: [
          {
            type: "application/ld+json",
            shape: { url: "string", items: [{ id: "number" }] },
          },
        ],
      });
    },
  );

  it("decodes attributes once, including encoded path and quote characters", () => {
    const facts = backendFacts(
      `<script src="/static/app.js?quote=&quot;&amp;v=1"></script>
<a href="&sol;api&sol;articles?quote=&quot;&amp;v=1">Articles</a>
<a href="/api/once?id=1&amp;amp;lang=en">Once</a>`,
      "https://site.example/page",
    );
    expect(facts.scripts).toEqual([
      "https://site.example/static/app.js?quote=%22&v=1",
    ]);
    expect(facts.endpoints).toEqual([
      "https://site.example/api/articles?quote=%22&v=1",
      "https://site.example/api/once?id=1&amp;lang=en",
    ]);
  });
});

describe("backend crawl routes", () => {
  it("decodes sitemap XML references once and preserves literal robots routes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://site.example/robots.txt")
        return new Response(
          "Allow: /api/articles?id=1&amp;lang=en\nDisallow: /api/raw?id=1&#38;lang=en",
        );
      if (url === "https://site.example/sitemap.xml")
        return new Response(`<urlset>
<url><loc>https://site.example/api/articles?id=1&amp;lang=en</loc></url>
<url><loc>https://site.example/api/articles?id=1&#38;lang=en</loc></url>
<url><loc>https://site.example/api/hex?id=1&#x26;lang=en</loc></url>
<url><loc>https://site.example/api/once?id=1&amp;amp;lang=en</loc></url>
<url><loc>https://site.example/api/named?q=&quot;x&quot;&amp;tag=&lt;x&gt;&amp;author=&apos;a&apos;</loc></url>
</urlset>`);
      return new Response("");
    });
    const { evidence, blobs } = await inspectBackend(
      "https://site.example/",
      1,
    );
    const crawlFiles = Object.fromEntries(
      evidence
        .filter((e) => e.kind === "links")
        .map((e) => {
          const blob = JSON.parse(String(blobs[e.id])) as {
            file: string;
            routes: string[];
          };
          return [blob.file, blob.routes];
        }),
    );
    expect(crawlFiles).toEqual({
      "/robots.txt": [
        "/api/articles?id=1&amp;lang=en",
        "/api/raw?id=1&#38;lang=en",
      ],
      "/sitemap.xml": [
        "https://site.example/api/articles?id=1&lang=en",
        "https://site.example/api/hex?id=1&lang=en",
        "https://site.example/api/once?id=1&amp;lang=en",
        "https://site.example/api/named?q=\"x\"&tag=<x>&author='a'",
      ],
    });
  });
});

describe("backend inspection cancellation", () => {
  it("does not fetch when inspection is already aborted", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected fetch"));
    const controller = new AbortController();
    const reason = new DOMException("Stopped", "AbortError");
    controller.abort(reason);
    await expect(
      inspectBackend("https://site.example/", 1, controller.signal),
    ).rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["page", "fetch"],
    ["page", "body"],
    ["robots", "fetch"],
    ["robots", "body"],
    ["sitemap", "fetch"],
    ["sitemap", "body"],
  ] as const)(
    "propagates abort during %s %s without subsequent requests",
    async (stage, part) => {
      const urls = [
        "https://site.example/",
        "https://site.example/robots.txt",
        "https://site.example/sitemap.xml",
      ];
      const index = ["page", "robots", "sitemap"].indexOf(stage);
      const requests: { url: string; signal: RequestInit["signal"] }[] = [];
      const controller = new AbortController();
      const reason = new DOMException("Stopped", "AbortError");
      let entered: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let finish: (() => void) | undefined;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        const signal = init?.signal;
        requests.push({ url, signal });
        if (url !== urls[index]) return new Response("");
        if (part === "fetch")
          return new Promise<Response>((resolve, reject) => {
            finish = () => resolve(new Response(""));
            signal?.addEventListener("abort", () => reject(signal?.reason), {
              once: true,
            });
            entered();
          });
        return new Response(
          new ReadableStream(
            {
              pull(stream) {
                return new Promise<void>((resolve) => {
                  finish = () => {
                    if (!signal?.aborted) stream.close();
                    resolve();
                  };
                  signal?.addEventListener(
                    "abort",
                    () => {
                      stream.error(signal?.reason);
                      resolve();
                    },
                    { once: true },
                  );
                  entered();
                });
              },
            },
            { highWaterMark: 0 },
          ),
        );
      });
      const outcome = inspectBackend(urls[0], 1, controller.signal).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await started;
        controller.abort(reason);
        finish?.();
        finish = undefined;
        expect(await outcome).toBe(reason);
        expect(requests).toEqual(
          urls
            .slice(0, index + 1)
            .map((url) => ({ url, signal: controller.signal })),
        );
      } finally {
        controller.abort(reason);
        finish?.();
        await outcome;
      }
    },
  );
});

describe("resolveRedirects", () => {
  // A fetch that answers each URL from a map: a string is a redirect target, a number a status.
  const site = (answers: Record<string, string | number>) =>
    vi.fn(async (url: string | URL | Request) => {
      const answer = answers[String(url)] ?? 200;
      return typeof answer === "number"
        ? new Response("ok", { status: answer })
        : new Response(null, { status: 301, headers: { location: answer } });
    }) as unknown as typeof fetch;

  it("follows wikipedia.com to wikipedia.org without following redirects automatically", async () => {
    const fetcher = site({
      "https://www.wikipedia.com/": "https://www.wikipedia.org/",
    });
    expect(
      await resolveRedirects("https://www.wikipedia.com/", fetcher),
    ).toEqual({
      url: "https://www.wikipedia.org/",
      chain: ["https://www.wikipedia.com/", "https://www.wikipedia.org/"],
    });
    expect(vi.mocked(fetcher).mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "manual",
    });
  });

  it("stops at the last safe URL when a hop is not https or not public", async () => {
    for (const target of [
      "http://example.org/",
      "https://127.0.0.1/admin",
      "https://localhost/",
      "https://[::1]/",
      "https://169.254.169.254/latest",
      "https://user:pw@example.org/",
    ]) {
      const fetcher = site({
        "https://example.com/": "https://www.example.com/",
        "https://www.example.com/": target,
      });
      const result = await resolveRedirects("https://example.com/", fetcher);
      expect(result.url).toBe("https://www.example.com/");
      expect(result.stopped).toBeDefined();
      // The unsafe target is never requested.
      expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(2);
    }
  });

  it("bounds the hops and keeps the entered URL when the fetch fails", async () => {
    const loop = vi.fn(
      async (url: string | URL | Request) =>
        new Response(null, {
          status: 302,
          headers: { location: `${String(url)}x` },
        }),
    ) as unknown as typeof fetch;
    const result = await resolveRedirects("https://example.com/", loop);
    expect(result.chain).toHaveLength(maxRedirects + 1);
    const down = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await resolveRedirects("https://example.com/", down)).toEqual({
      url: "https://example.com/",
      chain: ["https://example.com/"],
    });
  });
});
