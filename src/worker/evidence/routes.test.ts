import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { navigateSnippet, screenshotSnippet } from "./anchor";
import { surrealOk } from "./fixtures";

const surreal = {
  SURREALDB_URL: "https://db.example.test",
  SURREALDB_NAMESPACE: "reversy",
  SURREALDB_DATABASE: "main",
  SURREALDB_USERNAME: "user",
  SURREALDB_PASSWORD: "pass",
};
const body = {
  mode: "first_look",
  scope: { origin: "https://example.com", paths: ["/"] },
};
const call = (path: string, env: object, init?: RequestInit) =>
  worker.fetch(new Request(`https://reversy.test${path}`, init), env);
const post = (env: object, payload: unknown) =>
  call("/api/v1/runs/run_1/capture", env, {
    method: "POST",
    body: JSON.stringify(payload),
  });

afterEach(() => vi.unstubAllGlobals());

describe("evidence routes", () => {
  it("names every missing binding instead of capturing", async () => {
    const response = await post(
      { SURREALDB_URL: "https://db.example.test" },
      body,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Missing Worker bindings",
      missing: [
        "ANCHOR_API_KEY",
        "SURREALDB_NAMESPACE",
        "SURREALDB_DATABASE",
        "SURREALDB_USERNAME",
        "SURREALDB_PASSWORD",
      ],
    });
  });

  it("rejects a scope that is not a bare origin", async () => {
    const response = await post(
      { ANCHOR_API_KEY: "k", ...surreal },
      { ...body, scope: { origin: "https://example.com/app", paths: ["/"] } },
    );
    expect(response.status).toBe(400);
  });

  it("serves a stored record and its content (fixture SurrealDB)", async () => {
    const id = "ev_00000000-0000-4000-8000-000000000000";
    const record = {
      id,
      runId: "run_1",
      kind: "dom",
      label: "observed",
      pageOrState: "/",
      url: "https://example.com/",
      tool: "anchor",
      capturedAt: "2026-10-16T10:00:00.000Z",
      contentHash: "sha256:00",
      limitations: [],
      contentType: "text/html",
      byteLength: 3,
    };
    const replies = [
      surrealOk([record]),
      surrealOk([record]),
      surrealOk([1]),
      surrealOk(["PGg+"]),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(replies.shift())),
    );

    const json = await call(`/api/v1/evidence/${id}`, surreal);
    expect(await json.json()).toEqual(record);
    const content = await call(`/api/v1/evidence/${id}/content`, surreal);
    expect(content.headers.get("content-type")).toBe("text/html");
    expect(content.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'",
    );
    expect(await content.text()).toBe("<h>");
  });

  it("returns 404 for ids that are not evidence ids", async () => {
    expect((await call("/api/v1/evidence/nope", surreal)).status).toBe(404);
  });
});

describe("Anchor snippets", () => {
  // They run in Anchor's sandbox, so at least check they compile as async function bodies.
  const AsyncFunction = (async () => {}).constructor as new (
    ...args: string[]
  ) => unknown;

  it("compile as JavaScript with safely embedded parameters", () => {
    const url = 'https://example.com/"quoted"';
    const code = navigateSnippet(url, "https://example.com", true);
    expect(() => new AsyncFunction("page", code)).not.toThrow();
    expect(code).toContain(JSON.stringify(url));
    expect(
      () =>
        new AsyncFunction(
          "page",
          screenshotSnippet({ width: 390, height: 844 }),
        ),
    ).not.toThrow();
  });
});
