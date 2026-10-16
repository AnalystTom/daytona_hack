import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvidenceRecord } from "../../src/shared/evidence";
import {
  executeCodeResponse,
  fixturePageFacts,
  fixturePngBase64,
  fixtureSession,
  surrealOk,
} from "../../src/worker/evidence/fixtures";
import { leftScope } from "../../src/worker/evidence/capture";
import {
  capture,
  captureScope,
  isStoredEvidenceId,
  stoppedPages,
  toEvidence,
} from "./inspect";
import type { Env, Evidence } from "./types";

const surreal = {
  SURREALDB_URL: "https://db.example.test",
  SURREALDB_NAMESPACE: "reversy",
  SURREALDB_DATABASE: "main",
  SURREALDB_USER: "user",
  SURREALDB_PASSWORD: "pass",
};
const env = { ...surreal, ANCHORBROWSER_API_KEY: "anchor-key" } as Env;

const record = (over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: "ev_00000000-0000-4000-8000-000000000000",
  runId: "run-1",
  kind: "screenshot",
  label: "observed",
  pageOrState: "/ @ desktop 1440",
  url: "https://example.com/",
  tool: "anchor",
  capturedAt: "2026-10-16T10:00:00.000Z",
  contentHash: "sha256:00",
  limitations: ["Full-page capture after load."],
  contentType: "image/png",
  byteLength: 3,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("captureScope", () => {
  it("keeps the site's origin and unique paths, capped at ten", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `/p${i}`);
    const { scope, dropped } = captureScope("https://example.com/start?x=1", [
      "/",
      "/?ref=nav",
      ...paths,
    ]);
    expect(scope.origin).toBe("https://example.com");
    expect(scope.paths).toEqual(["/", ...paths.slice(0, 9)]);
    expect(dropped).toEqual(paths.slice(9));
  });

  it("leaves out paths that resolve off the site, falling back to the start page", () => {
    expect(
      captureScope("https://example.com/start", [
        "https://evil.test/admin",
        "//evil.test/x",
        "mailto:a@example.com",
      ]).scope,
    ).toEqual({ origin: "https://example.com", paths: ["/start"] });
    expect(
      captureScope("https://example.com", ["https://example.com/pricing"]).scope
        .paths,
    ).toEqual(["/pricing"]);
  });
});

describe("isStoredEvidenceId", () => {
  it("accepts SurrealDB evidence ids and refuses ids from older runs", () => {
    expect(isStoredEvidenceId("ev_00000000-0000-4000-8000-000000000000")).toBe(
      true,
    );
    expect(isStoredEvidenceId("ev_001")).toBe(false);
  });
});

describe("toEvidence", () => {
  it("links observed screenshots and recordings for the canvas", () => {
    const shot = toEvidence(record());
    expect(shot).toMatchObject({
      kind: "screenshot",
      status: "observed",
      page: "/ @ desktop 1440",
      path: `evidence/${record().id}.png`,
      url: `/runs/run-1/evidence/${record().id}`,
    });
    expect(
      toEvidence(record({ kind: "recording", contentType: "video/mp4" })).url,
    ).toBe(`/runs/run-1/evidence/${record().id}`);
    expect(
      toEvidence(record({ kind: "dom", contentType: "text/html" })),
    ).toMatchObject({ path: `evidence/${record().id}.html`, url: undefined });
  });

  it("gives not-observed items no file and keeps the reason", () => {
    const missing = toEvidence(
      record({
        label: "not_observed",
        contentType: "text/plain",
        limitations: [
          "Redirected to https://example.com/login?session=secret#x, outside the approved scope.",
        ],
      }),
    );
    expect(missing.path).toBeUndefined();
    expect(missing.url).toBeUndefined();
    expect(missing.limits).toBe(
      "Redirected to https://example.com/login outside the approved scope.",
    );
    expect(missing.summary).toBe("No screenshot of / @ desktop 1440");
  });
});

describe("stoppedPages", () => {
  it("lists pages that left the scope once each, not other failures", () => {
    const left = `${leftScope}; capture stopped for this page.`;
    expect(
      stoppedPages([
        record({
          label: "not_observed",
          url: "https://example.com/account",
          limitations: [`Redirected to /login, ${left}`],
        }),
        record({
          label: "not_observed",
          kind: "dom",
          url: "https://example.com/account",
          limitations: [`Redirected to /login, ${left}`],
        }),
        record({
          label: "not_observed",
          url: "https://example.com/pricing",
          limitations: ["Capture failed: Anchor timeout"],
        }),
        record({ url: "https://example.com/" }),
      ]),
    ).toEqual(["/account"]);
  });
});

describe("capture", () => {
  it("does not publish a record whose storage finishes after cancellation", async () => {
    let enter!: () => void;
    const entered = new Promise<void>((done) => {
      enter = done;
    });
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    const ended: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit = {}) => {
        const url = new URL(input);
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        if (url.host === "db.example.test") {
          if (body.params[0].startsWith("CREATE evidence:")) {
            enter();
            await pending;
          }
          return Response.json(surrealOk([]));
        }
        if (url.pathname === "/v1/sessions")
          return Response.json(fixtureSession);
        if (url.pathname === "/v1/tools/execute-code")
          return Response.json(
            executeCodeResponse({
              finalUrl: "https://example.com/",
              png: fixturePngBase64,
            }),
          );
        if (init.method === "DELETE") {
          ended.push(url.pathname);
          return Response.json({ data: { status: "ok" } });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );
    const controller = new AbortController();
    const landed = vi.fn();
    const owned = vi.fn();
    const result = capture(
      env,
      "run-1",
      {
        mode: "first_look",
        scope: { origin: "https://example.com", paths: ["/"] },
      },
      landed,
      { signal: controller.signal, onSession: owned },
    );
    await entered;
    controller.abort();
    expect(owned).toHaveBeenCalledOnce();
    expect(ended).toEqual([`/v1/sessions/${fixtureSession.data.id}`]);
    release();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(landed).not.toHaveBeenCalled();
  });

  it("names a missing Anchor key or SurrealDB binding instead of capturing", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const request = {
      mode: "first_look" as const,
      scope: { origin: "https://example.com", paths: ["/"] },
    };
    await expect(
      capture({ ...surreal } as Env, "run-1", request, async () => {}),
    ).rejects.toThrow("missing ANCHORBROWSER_API_KEY");
    await expect(
      capture(
        { ANCHORBROWSER_API_KEY: "k" } as Env,
        "run-1",
        request,
        async () => {},
      ),
    ).rejects.toThrow("missing SURREALDB_URL");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stores each record in SurrealDB and hands it on as it lands", async () => {
    const stored: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit = {}) => {
        const url = new URL(input);
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        if (url.host === "db.example.test") {
          const sql: string = body.params[0];
          if (sql.startsWith("CREATE evidence:")) stored.push(sql);
          return Response.json(surrealOk([]));
        }
        if (url.pathname === "/v1/sessions")
          return Response.json(fixtureSession);
        if (url.pathname === "/v1/tools/execute-code") {
          return Response.json(
            executeCodeResponse(
              body.code.includes("page.goto")
                ? fixturePageFacts("https://example.com/")
                : { finalUrl: "https://example.com/", png: fixturePngBase64 },
            ),
          );
        }
        if (init.method === "DELETE")
          return Response.json({ data: { status: "ok" } });
        return new Response("unexpected", { status: 500 });
      }),
    );
    const landed: Evidence[] = [];

    const result = await capture(
      env,
      "run-1",
      {
        mode: "first_look",
        scope: { origin: "https://example.com", paths: ["/"] },
      },
      async (e) => void landed.push(e),
    );

    expect(result.status).toBe("captured");
    expect(stored).toHaveLength(1);
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({
      kind: "screenshot",
      status: "observed",
      tool: "anchor",
      page: "/ @ desktop 1440",
    });
    expect(landed[0]?.url).toMatch(
      /^\/runs\/run-1\/evidence\/ev_[0-9a-f-]{36}$/,
    );
  });
});
