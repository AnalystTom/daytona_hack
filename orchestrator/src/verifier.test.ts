import { afterEach, describe, expect, it, vi } from "vitest";
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
  ev("ev_001", "/api/articles", "observed"),
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
function stub() {
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
    if (url === `${PREVIEW}api/articles`)
      return Response.json({ items: [{ id: 1, title: "t" }], total: 1 });
    return Response.json({ error: "not found" }, { status: 404 });
  });
  return { requests, inputs };
}

const env = { ORCHESTRATOR_MODEL: "m" } as Env;

afterEach(() => vi.unstubAllGlobals());

describe("backend verification", () => {
  it("probes the task's observed routes instead of the preview root", async () => {
    const { requests, inputs } = stub();
    await verifyTask(env, spec("backend"), evidence, task, PREVIEW);

    expect(requests).toEqual([
      { url: `${PREVIEW}api/articles`, method: "GET" },
      { url: `${PREVIEW}api/v1/articles?id=1`, method: "GET" },
    ]);
    expect(inputs[0].previewHtml).toBe("");
    expect(inputs[0].routes).toEqual([
      {
        path: "/api/articles",
        status: 200,
        contentType: "application/json",
        shape: { items: [{ id: "number", title: "string" }], total: "number" },
      },
      {
        path: "/api/v1/articles?id=1",
        status: 404,
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
      contentType: "application/json",
      shape: { error: "string" },
    });
  });

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
});
