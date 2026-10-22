import { testStorage } from "../test/storage";
import { D1RunStore } from "../store/d1";
import { cloudflareEvidenceStore } from "./store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEnvelope } from "../../shared/contracts";
import worker from "../index";
import { navigateSnippet, screenshotSnippet } from "./anchor";
import {
  executeCodeResponse,
  fixturePngBase64,
  fixtureSession,
} from "./fixtures";

const cloudflare = testStorage();
const body = {
  mode: "first_look",
  scope: { origin: "https://example.com", paths: ["/"] },
};
const operator = { OPERATOR_TOKEN: "op-secret" };
const call = (
  path: string,
  env: object,
  init?: RequestInit,
  token = operator.OPERATOR_TOKEN,
) =>
  worker.fetch(
    new Request(`https://reversy.test${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}` },
    }),
    { ...operator, ...env },
  );
const post = (env: object, payload: unknown) =>
  call("/api/v1/runs/run_1/capture", env, {
    method: "POST",
    body: JSON.stringify(payload),
  });

afterEach(() => vi.unstubAllGlobals());

describe("evidence routes", () => {
  it("names every missing binding instead of capturing", async () => {
    const response = await post({}, body);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Missing Worker bindings",
      missing: ["ANCHOR_API_KEY", "DB", "BLOBS"],
    });
  });

  it("names OPERATOR_TOKEN when it is unset", async () => {
    for (const path of [
      "/api/v1/runs/run_1/capture",
      "/api/v1/evidence/ev_x",
      "/api/v1/evidence/ev_x/content",
    ]) {
      const response = await call(
        path,
        { OPERATOR_TOKEN: undefined, ...cloudflare },
        path.endsWith("capture") ? { method: "POST" } : undefined,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        missing: ["OPERATOR_TOKEN"],
      });
    }
  });

  it("refuses a missing or wrong operator token on every route", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const id = "ev_00000000-0000-4000-8000-000000000000";
    for (const token of ["wrong", "", "op-secret-longer"]) {
      for (const [path, init] of [
        ["/api/v1/runs/run_1/capture", { method: "POST", body: "{}" }],
        [`/api/v1/evidence/${id}`, undefined],
        [`/api/v1/evidence/${id}/content`, undefined],
      ] as const) {
        const response = await call(
          path,
          { ANCHOR_API_KEY: "k", ...cloudflare },
          init,
          token,
        );
        expect(response.status).toBe(401);
      }
    }
    const bare = await worker.fetch(
      new Request(`https://reversy.test/api/v1/evidence/${id}`),
      { ...operator, ...cloudflare },
    );
    expect(bare.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers malformed escapes in ids with 400 and 404, not a crash", async () => {
    const capture = await call(
      "/api/v1/runs/%E0/capture",
      { ANCHOR_API_KEY: "k", ...cloudflare },
      { method: "POST", body: JSON.stringify(body) },
    );
    expect(capture.status).toBe(400);
    expect((await call("/api/v1/evidence/%E0", cloudflare)).status).toBe(404);
    expect(
      (await call("/api/v1/evidence/%E0/content", cloudflare)).status,
    ).toBe(404);
  });

  it("rejects a scope that is not a bare origin", async () => {
    const response = await post(
      { ANCHOR_API_KEY: "k", ...cloudflare },
      { ...body, scope: { origin: "https://example.com/app", paths: ["/"] } },
    );
    expect(response.status).toBe(400);
  });

  it("serves a stored record and its content from D1 and R2", async () => {
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
    await cloudflareEvidenceStore(
      new D1RunStore(cloudflare.DB, cloudflare.BLOBS),
    ).putEvidence(
      record as import("../../shared/evidence").EvidenceRecord,
      new Uint8Array([60, 104, 62]),
    );

    const json = await call(`/api/v1/evidence/${id}`, cloudflare);
    expect(await json.json()).toEqual(record);
    const content = await call(`/api/v1/evidence/${id}/content`, cloudflare);
    expect(content.headers.get("content-type")).toBe("text/html");
    expect(content.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'",
    );
    expect(await content.text()).toBe("<h>");
  });

  // Seeds run_1 in local D1 only when `runExists`; fetch is stubbed for Anchor.
  async function fakeBackends(runExists: boolean) {
    if (runExists)
      await new D1RunStore(cloudflare.DB).createRun({
        id: "run_1",
        url: "https://example.com/",
        goal: "Rebuild it",
        status: "active",
        createdAt: "2026-10-16T10:00:00.000Z",
        updatedAt: "2026-10-16T10:00:00.000Z",
        specApprovedAt: null,
      });
    const anchorCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit = {}) => {
        const url = new URL(input);
        anchorCalls.push(url.pathname);
        if (url.pathname === "/v1/sessions")
          return Response.json(fixtureSession);
        if (url.pathname === "/v1/tools/execute-code") {
          return Response.json(
            executeCodeResponse({
              finalUrl: "https://example.com/",
              png: fixturePngBase64,
            }),
          );
        }
        return Response.json({ data: { status: "ok" } });
      }),
    );
    return { anchorCalls };
  }

  it("returns 404 without opening Anchor when the run does not exist", async () => {
    const { anchorCalls } = await fakeBackends(false);
    const response = await post({ ANCHOR_API_KEY: "k", ...cloudflare }, body);
    expect(response.status).toBe(404);
    expect(anchorCalls).toEqual([]);
  });

  it("appends capture events to the run as full event envelopes", async () => {
    await fakeBackends(true);
    const response = await post({ ANCHOR_API_KEY: "k", ...cloudflare }, body);
    expect(response.status).toBe(200);
    const envelopes = await new D1RunStore(cloudflare.DB).listEvents(
      "run_1",
      0,
      100,
    );
    for (const envelope of envelopes) EventEnvelope.parse(envelope);
    expect(envelopes.map((e) => [e.runId, e.type])).toEqual([
      ["run_1", "evidence.page_captured"],
      ["run_1", "evidence.capture_finished"],
    ]);
    expect(new Set(envelopes.map((e) => e.eventId)).size).toBe(2);
  });

  it("returns 404 for ids that are not evidence ids", async () => {
    expect((await call("/api/v1/evidence/nope", cloudflare)).status).toBe(404);
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
