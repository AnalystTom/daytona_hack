import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureEvent, EvidenceRecord } from "../../shared/evidence";
import { CaptureError, captureRun } from "./capture";
import {
  executeCodeResponse,
  fixturePageFacts,
  fixturePngBase64,
  fixtureSession,
  recordingList,
} from "./fixtures";
import type { EvidenceStore, SignIn } from "./store";

const scope = { origin: "https://example.com", paths: ["/", "/pricing"] };

// Fixture Anchor API: answers each endpoint with the documented response shape.
function fakeAnchor(finalUrls: Record<string, string> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let current = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === "/v1/sessions") return Response.json(fixtureSession);
      if (url.pathname === "/v1/tools/execute-code") {
        const code: string = body.code;
        if (code.includes("page.goto")) {
          const target = JSON.parse(
            code.match(/const params = (.*);/)?.[1] ?? "{}",
          ).url;
          current = finalUrls[target] ?? target;
          return Response.json(executeCodeResponse(fixturePageFacts(current)));
        }
        return Response.json(
          executeCodeResponse({ finalUrl: current, png: fixturePngBase64 }),
        );
      }
      if (url.pathname.endsWith("/recordings"))
        return Response.json(recordingList);
      if (url.pathname.endsWith("/recordings/primary/fetch")) {
        return new Response(new Uint8Array([0, 0, 0, 24]));
      }
      if (method === "DELETE") return Response.json({ data: { status: "ok" } });
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

function memoryStore() {
  const records = new Map<string, EvidenceRecord>();
  const content = new Map<string, Uint8Array>();
  const signIns = new Map<string, SignIn>();
  const store: EvidenceStore = {
    async putEvidence(record, bytes) {
      records.set(record.id, record);
      content.set(record.id, bytes);
    },
    getEvidence: async (id) => records.get(id) ?? null,
    getContent: async (id) => content.get(id) ?? null,
    async saveSignIn(runId, signIn) {
      signIns.set(runId, signIn);
    },
    async takeSignIn(runId) {
      const id = signIns.get(runId) ?? null;
      signIns.delete(runId);
      return id;
    },
  };
  return { store, records, content, signIns };
}

function deps(store: EvidenceStore) {
  const events: CaptureEvent[] = [];
  return {
    events,
    deps: {
      anchorApiKey: "test-key",
      store,
      emit: (e: CaptureEvent) => void events.push(e),
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("captureRun (fixture Anchor responses)", () => {
  it("captures a full pack per page with hashes and a recording", async () => {
    const calls = fakeAnchor();
    const memory = memoryStore();
    const { deps: d, events } = deps(memory.store);

    const result = await captureRun(d, "run_1", { mode: "full_pack", scope });

    expect(result.status).toBe("captured");
    const items = result.status === "captured" ? result.items : [];
    expect(items.map((i) => `${i.kind} ${i.pageOrState}`)).toEqual([
      "dom /",
      "styles /",
      "assets /",
      "network /",
      "screenshot / @ desktop 1440",
      "screenshot / @ mobile 390",
      "dom /pricing",
      "styles /pricing",
      "assets /pricing",
      "network /pricing",
      "screenshot /pricing @ desktop 1440",
      "screenshot /pricing @ mobile 390",
      "recording session: /, /pricing",
    ]);
    expect(
      items.every((i) => i.label === "observed" && i.tool === "anchor"),
    ).toBe(true);
    const shot = items.find((i) => i.kind === "screenshot") as EvidenceRecord;
    expect(shot.contentType).toBe("image/png");
    expect(memory.content.get(shot.id)?.[1]).toBe(0x50); // "P" of the PNG signature
    expect(shot.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const session = calls.find((c) => c.path === "/v1/sessions")?.body as {
      session: { recording: { active: boolean } };
      browser: {
        viewport: { width: number };
        sensitive_data_mask: { active: boolean };
      };
    };
    expect(session.session.recording.active).toBe(true);
    expect(session.browser.viewport.width).toBe(1440);
    expect(session.browser.sensitive_data_mask.active).toBe(true);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      "evidence.page_captured",
      "evidence.page_captured",
      "evidence.capture_finished",
    ]);
  });

  it("takes only a desktop screenshot per page on first look, without recording", async () => {
    const calls = fakeAnchor();
    const { deps: d } = deps(memoryStore().store);

    const result = await captureRun(d, "run_1", { mode: "first_look", scope });

    const items = result.status === "captured" ? result.items : [];
    expect(items.map((i) => i.pageOrState)).toEqual([
      "/ @ desktop 1440",
      "/pricing @ desktop 1440",
    ]);
    expect(calls.some((c) => c.path.includes("recordings"))).toBe(false);
  });

  it("stops a page that redirects off-origin and stores nothing from it", async () => {
    const calls = fakeAnchor({
      "https://example.com/pricing": "https://evil.test/pricing",
    });
    const memory = memoryStore();
    const { deps: d, events } = deps(memory.store);

    const result = await captureRun(d, "run_1", { mode: "full_pack", scope });

    const items = result.status === "captured" ? result.items : [];
    const pricing = items.filter((i) => i.pageOrState.startsWith("/pricing"));
    expect(pricing).toHaveLength(6);
    for (const item of pricing) {
      expect(item.label).toBe("not_observed");
      expect(item.byteLength).toBe(0);
      expect(item.limitations[0]).toContain(
        "Redirected to https://evil.test/pricing",
      );
    }
    expect(events[1]?.type).toBe("evidence.page_stopped");
    const recording = items.find((i) => i.kind === "recording");
    expect(recording?.label).toBe("not_observed");
    expect(recording?.limitations[0]).toBe(
      "Session left the approved scope: https://evil.test/pricing",
    );
    expect(calls.some((c) => c.path.includes("recordings"))).toBe(false);
  });

  it("keeps an off-scope URL's query string out of the event message", async () => {
    fakeAnchor({
      "https://example.com/pricing":
        "https://idp.test/login?code=secret#state=x",
    });
    const { deps: d, events } = deps(memoryStore().store);

    const result = await captureRun(d, "run_1", { mode: "full_pack", scope });

    const items = result.status === "captured" ? result.items : [];
    const stopped = items.find((i) => i.pageOrState === "/pricing");
    expect(stopped?.limitations[0]).toContain(
      "https://idp.test/login?code=secret#state=x",
    );
    expect(events[1]?.message).toBe(
      "/pricing: Redirected to https://idp.test/login, outside the approved scope; capture stopped for this page.",
    );
    expect(events.some((e) => e.message.includes("secret"))).toBe(false);
  });

  it("stops a page that redirects to an unapproved path on the same origin", async () => {
    fakeAnchor({ "https://example.com/pricing": "https://example.com/login" });
    const { deps: d } = deps(memoryStore().store);

    const result = await captureRun(d, "run_1", { mode: "first_look", scope });

    const items = result.status === "captured" ? result.items : [];
    expect(items.map((i) => i.label)).toEqual(["observed", "not_observed"]);
  });

  it("hands sign-in to the user, then resumes capture in that session once", async () => {
    const calls = fakeAnchor();
    const memory = memoryStore();
    const { deps: d } = deps(memory.store);

    const started = await captureRun(d, "run_1", {
      mode: "full_pack",
      scope,
      signIn: "start",
    });
    expect(started).toEqual({
      status: "awaiting_sign_in",
      liveViewUrl: fixtureSession.data.live_view_url,
    });
    const body = calls[0]?.body as {
      session: {
        initial_url: string;
        recording: { active: boolean };
        live_view: { read_only: boolean };
      };
    };
    expect(body.session.initial_url).toBe("https://example.com/");
    expect(body.session.recording.active).toBe(false);
    expect(body.session.live_view.read_only).toBe(false);
    expect(memory.signIns.get("run_1")).toEqual({
      sessionId: fixtureSession.data.id,
      origin: "https://example.com",
    });

    const resumed = await captureRun(d, "run_1", {
      mode: "full_pack",
      scope,
      signIn: "resume",
    });
    const items = resumed.status === "captured" ? resumed.items : [];
    expect(calls.filter((c) => c.path === "/v1/sessions")).toHaveLength(1);
    expect(items.at(-1)).toMatchObject({
      kind: "recording",
      label: "not_observed",
    });
    expect(items[0]?.limitations.at(-1)).toContain("signed-in session");
    for (const kind of ["dom", "assets", "network"]) {
      const skipped = items.filter((i) => i.kind === kind);
      expect(skipped).toHaveLength(2);
      for (const item of skipped) {
        expect(item).toMatchObject({ label: "not_observed", byteLength: 0 });
        expect(item.limitations[0]).toContain("until masking exists");
        expect(memory.content.get(item.id)).toEqual(new Uint8Array());
      }
    }
    expect(
      items.filter((i) => i.kind === "styles" || i.kind === "screenshot"),
    ).toSatisfy((kept: EvidenceRecord[]) =>
      kept.every((i) => i.label === "observed"),
    );

    await expect(
      captureRun(d, "run_1", { mode: "full_pack", scope, signIn: "resume" }),
    ).rejects.toThrow(CaptureError);
  });
});

describe("captureRun limits", () => {
  it("skips a recording too large to store", async () => {
    fakeAnchor();
    const big = structuredClone(recordingList);
    (big.data.items[0] as { size: number }).size = 30_000_000;
    const anchorFetch = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) =>
        input.endsWith("/recordings")
          ? Response.json(big)
          : anchorFetch(input, init),
      ),
    );
    const { deps: d } = deps(memoryStore().store);

    const result = await captureRun(d, "run_1", { mode: "full_pack", scope });

    const items = result.status === "captured" ? result.items : [];
    expect(items.at(-1)).toMatchObject({
      kind: "recording",
      label: "not_observed",
    });
    expect(items.at(-1)?.limitations[0]).toContain(
      "over the 25 MB storage limit",
    );
  });

  it("skips a recording too large to store when Anchor reports no size", async () => {
    fakeAnchor();
    const unsized = structuredClone(recordingList);
    delete (unsized.data.items[0] as { size?: number }).size;
    const anchorFetch = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) =>
        input.endsWith("/recordings")
          ? Response.json(unsized)
          : input.endsWith("/recordings/primary/fetch")
            ? new Response(new Uint8Array(25_000_001))
            : anchorFetch(input, init),
      ),
    );
    const { deps: d } = deps(memoryStore().store);

    const result = await captureRun(d, "run_1", { mode: "full_pack", scope });

    const items = result.status === "captured" ? result.items : [];
    expect(items.at(-1)).toMatchObject({
      kind: "recording",
      label: "not_observed",
    });
    expect(items.at(-1)?.limitations[0]).toContain(
      "over the 25 MB storage limit",
    );
  });

  it("fails the capture when storage fails instead of faking not_observed", async () => {
    fakeAnchor();
    const { store } = memoryStore();
    store.putEvidence = async () => {
      throw new Error("SurrealDB request failed with 500");
    };
    const { deps: d } = deps(store);

    await expect(
      captureRun(d, "run_1", { mode: "first_look", scope }),
    ).rejects.toThrow("SurrealDB request failed");
  });
});

describe("captureRun sign-in scope", () => {
  it("refuses to resume a sign-in session on a different origin", async () => {
    const calls = fakeAnchor();
    const memory = memoryStore();
    const { deps: d } = deps(memory.store);
    await captureRun(d, "run_1", { mode: "full_pack", scope, signIn: "start" });

    await expect(
      captureRun(d, "run_1", {
        mode: "full_pack",
        scope: { origin: "https://other.test", paths: ["/"] },
        signIn: "resume",
      }),
    ).rejects.toThrow("different origin");
    expect(calls.some((c) => c.path === "/v1/tools/execute-code")).toBe(false);
    expect(calls.at(-1)?.method).toBe("DELETE");
  });
});

describe("captureRun session cleanup", () => {
  it("ends the new sign-in session when saving it fails", async () => {
    const calls = fakeAnchor();
    const { store } = memoryStore();
    store.saveSignIn = async () => {
      throw new Error("SurrealDB request failed with 500");
    };
    const { deps: d } = deps(store);

    await expect(
      captureRun(d, "run_1", { mode: "full_pack", scope, signIn: "start" }),
    ).rejects.toThrow("SurrealDB request failed");
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/v1/sessions/${fixtureSession.data.id}`,
    });
  });

  it("ends the new sign-in session when reading the earlier one fails", async () => {
    const calls = fakeAnchor();
    const { store } = memoryStore();
    store.takeSignIn = async () => {
      throw new Error("SurrealDB request failed with 500");
    };
    const { deps: d } = deps(store);

    await expect(
      captureRun(d, "run_1", { mode: "full_pack", scope, signIn: "start" }),
    ).rejects.toThrow("SurrealDB request failed");
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/v1/sessions/${fixtureSession.data.id}`,
    });
  });

  it("ends a run's earlier sign-in session when sign-in starts again", async () => {
    const calls = fakeAnchor();
    const memory = memoryStore();
    memory.signIns.set("run_1", {
      sessionId: "old-session",
      origin: "https://example.com",
    });
    const { deps: d } = deps(memory.store);

    await captureRun(d, "run_1", { mode: "full_pack", scope, signIn: "start" });

    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "DELETE",
        path: "/v1/sessions/old-session",
      }),
    );
    expect(memory.signIns.get("run_1")?.sessionId).toBe(fixtureSession.data.id);
  });
});
