import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { inspectBackend } from "./inspect";
import type { Env, Evidence, Spec, Task } from "./types";
import { verifyFinal, verifyTask } from "./verifier";

const PREVIEW = "https://3000-abc.proxy.example/";

const ev = (id: string, page: string, status: Evidence["status"]) =>
  ({
    id,
    page,
    kind: "network",
    tool: "fetch",
    status,
    capturedAt: "",
    hash: "",
    summary: `GET ${page} -> 200 application/json`,
    limits: "",
  }) as Evidence;

const evidence = [
  {
    ...ev("ev_001", "/api/articles", "observed"),
    response: {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "max-age=60",
        vary: "Accept-Encoding",
      },
      shape: { items: [{ id: "number", title: "string" }], total: "number" },
    },
  },
  ev("ev_002", "/api/search", "observed"),
  {
    ...ev("ev_003", "/api/articles", "inferred"),
    routes: ["/api/v1/articles?id=1"],
  },
];

const spec = (scope: Spec["scope"]) =>
  ({ url: "https://site.example/", goal: "g", scope }) as Spec;

const task = {
  id: "t02",
  title: "articles route",
  acceptance: ["a"],
  evidence: ["ev_001", "ev_003"],
} as Task;

// Stubs the model and the preview; records every request and what the verifier was shown.
function stub(html?: string) {
  const requests: { url: string; method: string }[] = [];
  const inputs: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.openai.com/v1/responses") {
      inputs.push(JSON.parse(JSON.parse(String(init?.body)).input));
      return Response.json({
        output_text: JSON.stringify({
          pass: true,
          summary: "ok",
          findings: [],
        }),
      });
    }
    requests.push({ url, method: init?.method ?? "GET" });
    if (url === "https://site.example/" && html !== undefined)
      return new Response(html, { headers: { "content-type": "text/html" } });
    if (url.startsWith("https://site.example/api/articles?"))
      return Response.json({ items: [{ id: 1, title: "t" }], total: 1 });
    if (
      url === `${PREVIEW}api/articles` ||
      url === `${PREVIEW}api/articles?id=1`
    )
      return Response.json(
        { items: [{ id: 1, title: "t" }], total: 1 },
        {
          headers: {
            "cache-control": "no-cache",
            vary: "Origin",
            "set-cookie": "session=private",
            "x-private": "private",
          },
        },
      );
    return Response.json({ error: "not found" }, { status: 404 });
  });
  return { requests, inputs };
}

const env = { ORCHESTRATOR_MODEL: "m" } as Env;

afterEach(() => vi.unstubAllGlobals());

describe("backend verification", () => {
  it.each(["backend", "both"] as const)(
    "probes decoded HTML endpoints and unchanged script endpoints for %s",
    async (scope) => {
      const { requests, inputs } = stub(
        `<a href="/api/articles?id=1&amp;lang=en">Articles</a>
<script>fetch("/api/raw?id=1&amp;lang=en")</script>
<a href="https://elsewhere.example/api/external?id=1&amp;lang=en">Elsewhere</a>`,
      );
      const { evidence } = await inspectBackend("https://site.example/", 1);
      const inferred = evidence.find((e) => e.status === "inferred");
      assert(inferred);
      expect(inferred.routes).toEqual([
        "/api/articles?id=1&lang=en",
        "/api/raw?id=1&amp;lang=en",
      ]);
      const routeTask = { ...task, evidence: [inferred.id] };
      requests.length = 0;
      await verifyTask(env, spec(scope), evidence, routeTask, PREVIEW);
      await verifyFinal(env, spec(scope), evidence, [routeTask], PREVIEW);
      expect(requests.filter((r) => r.url !== PREVIEW)).toEqual([
        { url: `${PREVIEW}api/articles?id=1&lang=en`, method: "GET" },
        { url: `${PREVIEW}api/raw?id=1&amp;lang=en`, method: "GET" },
        { url: `${PREVIEW}api/articles?id=1&lang=en`, method: "GET" },
        { url: `${PREVIEW}api/raw?id=1&amp;lang=en`, method: "GET" },
      ]);
      for (const input of inputs)
        expect(input.evidence).toContainEqual(
          expect.objectContaining({ id: inferred.id, routes: inferred.routes }),
        );
    },
  );

  it("probes the task's observed routes instead of the preview root", async () => {
    const { requests, inputs } = stub();
    await verifyTask(env, spec("backend"), evidence, task, PREVIEW);

    expect(requests).toEqual([
      { url: `${PREVIEW}api/articles`, method: "GET" },
      { url: `${PREVIEW}api/v1/articles?id=1`, method: "GET" },
    ]);
    expect(inputs[0].previewHtml).toBe("");
    expect(inputs[0].evidence).toContainEqual(
      expect.objectContaining({ id: "ev_001", response: evidence[0].response }),
    );
    expect(inputs[0].routes).toEqual([
      {
        path: "/api/articles",
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-cache",
          vary: "Origin",
        },
        contentType: "application/json",
        shape: { items: [{ id: "number", title: "string" }], total: "number" },
      },
      {
        path: "/api/v1/articles?id=1",
        status: 404,
        headers: { "content-type": "application/json" },
        contentType: "application/json",
        shape: { error: "string" },
      },
    ]);
  });

  it("probes every observed route at the end and reports missing ones", async () => {
    const { requests, inputs } = stub();
    await verifyFinal(env, spec("backend"), evidence, [task], PREVIEW);

    expect(requests.map((r) => r.url)).toEqual([
      `${PREVIEW}api/articles`,
      `${PREVIEW}api/search`,
      `${PREVIEW}api/v1/articles?id=1`,
    ]);
    expect(inputs[0].routes).toContainEqual({
      path: "/api/search",
      status: 404,
      headers: { "content-type": "application/json" },
      contentType: "application/json",
      shape: { error: "string" },
    });
    expect(inputs[0].routes).toContainEqual(
      expect.objectContaining({
        path: "/api/articles",
        headers: {
          "content-type": "application/json",
          "cache-control": "no-cache",
          vary: "Origin",
        },
      }),
    );
  });

  it.each(["backend", "both"] as const)(
    "preserves observed query variants from capture through task and final checks for %s",
    async (scope) => {
      const { requests, inputs } = stub();
      const captured: Evidence[] = [];
      for (const id of [1, 2]) {
        const capture = await inspectBackend(
          `https://site.example/api/articles?id=${id}`,
          captured.length + 1,
        );
        captured.push(...capture.evidence);
      }
      const observed = captured.filter(
        (e) => e.kind === "network" && e.status === "observed",
      );
      expect(observed.map((e) => e.page)).toEqual([
        "/api/articles?id=1",
        "/api/articles?id=2",
      ]);
      const queryTask = { ...task, evidence: observed.map((e) => e.id) };
      requests.length = 0;
      await verifyTask(env, spec(scope), captured, queryTask, PREVIEW);
      await verifyFinal(env, spec(scope), captured, [queryTask], PREVIEW);
      const probes = requests.filter((r) => r.url !== PREVIEW);
      expect(probes).toEqual([
        { url: `${PREVIEW}api/articles?id=1`, method: "GET" },
        { url: `${PREVIEW}api/articles?id=2`, method: "GET" },
        { url: `${PREVIEW}api/articles?id=1`, method: "GET" },
        { url: `${PREVIEW}api/articles?id=2`, method: "GET" },
      ]);
      for (const input of inputs) {
        expect(input.routes).toEqual([
          expect.objectContaining({
            path: "/api/articles?id=1",
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-cache",
              vary: "Origin",
            },
          }),
          expect.objectContaining({
            path: "/api/articles?id=2",
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        ]);
      }
    },
  );

  it("checks both the page and the routes for a both-scope run", async () => {
    const { requests } = stub();
    await verifyTask(env, spec("both"), evidence, task, PREVIEW);
    expect(requests.map((r) => r.url)).toEqual([
      PREVIEW,
      `${PREVIEW}api/articles`,
      `${PREVIEW}api/v1/articles?id=1`,
    ]);
  });

  it("leaves frontend verification on the preview root", async () => {
    const { requests, inputs } = stub();
    await verifyTask(env, spec("frontend"), evidence, task, PREVIEW);
    expect(requests.map((r) => r.url)).toEqual([PREVIEW]);
    expect(inputs[0].routes).toEqual([]);
  });

  it("does not follow protocol-relative evidence paths outside the preview", async () => {
    const { requests, inputs } = stub();
    await verifyTask(
      env,
      spec("backend"),
      [ev("ev_001", "//elsewhere.example/api", "observed")],
      task,
      PREVIEW,
    );
    expect(requests).toEqual([]);
    expect(inputs[0].routes).toEqual([
      {
        path: "//elsewhere.example/api",
        error: "route leaves the preview origin",
      },
    ]);
  });

  it("caps the final check at ten GETs", async () => {
    const { requests } = stub();
    await verifyFinal(
      env,
      spec("backend"),
      Array.from({ length: 12 }, (_, i) =>
        ev(`ev_${i}`, `/api/${i}`, "observed"),
      ),
      [],
      PREVIEW,
    );
    expect(requests).toHaveLength(10);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
});
