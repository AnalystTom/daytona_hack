import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { surrealOk } from "../evidence/fixtures";
import { type ExampleEnv, handleExample } from "./routes";
import { exportRun, loadMedia, loadSnapshot, saveSnapshot } from "./snapshot";

const RUN = "03b191c5-e0dc-4f8b-aa97-2e8da09db3f0";
const SANDBOX = "a536d976-sandbox";
const PREVIEW = `https://3000-${SANDBOX}.daytonaproxy01.eu`;
const png = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);

const state = (phase = "done") => ({
  id: RUN,
  phase,
  spec: { url: "https://www.daytona.io/" },
  sandboxId: SANDBOX,
  previewUrl: PREVIEW,
});
const events = [
  {
    seq: 1,
    ts: "2026-10-16T18:35:11.992Z",
    type: "phase",
    data: { phase: "brief" },
  },
  {
    seq: 2,
    ts: "2026-10-16T18:35:23.043Z",
    type: "evidence",
    data: {
      id: "ev_001",
      kind: "screenshot",
      url: `/runs/${RUN}/evidence/ev_001`,
    },
  },
  {
    seq: 3,
    ts: "2026-10-16T18:35:27.412Z",
    type: "evidence",
    data: { id: "ev_002", kind: "html" },
  },
  {
    seq: 4,
    ts: "2026-10-16T18:47:13.869Z",
    type: "preview",
    data: { url: PREVIEW, sandboxId: SANDBOX },
  },
  {
    seq: 5,
    ts: "2026-10-16T19:11:26.709Z",
    type: "chat",
    data: { role: "assistant", text: `Build finished. Preview: ${PREVIEW}` },
  },
  {
    seq: 6,
    ts: "2026-10-16T19:11:27.000Z",
    type: "verification",
    data: {
      summary:
        "Checked https://3000-signedtoken123.proxy.daytona.works/?a=1 ok",
    },
  },
];

function fakeOrchestrator(phase = "done", runId = RUN, bytes = png) {
  const seen: string[] = [];
  const fetcher = {
    fetch: async (url: string) => {
      seen.push(url);
      const path = new URL(url).pathname;
      if (path === `/runs/${runId}`)
        return Response.json({ ...state(phase), id: runId });
      if (path === `/runs/${runId}/events`)
        return new Response(JSON.stringify(events).replaceAll(RUN, runId));
      if (path === `/runs/${runId}/evidence/ev_001`)
        return new Response(bytes, {
          headers: { "content-type": "image/png" },
        });
      if (path.startsWith("/runs/")) return new Response("");
      return Response.json({ error: "not found" }, { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, seen };
}

// A SurrealDB RPC endpoint holding the example table in memory.
function fakeSurreal() {
  const rows = new Map<string, unknown>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const [sql, vars] = JSON.parse(String(init.body)).params;
      if (sql.startsWith("UPSERT")) rows.set(vars.key, vars.value);
      if (sql.startsWith("SELECT"))
        return Response.json(
          surrealOk(rows.has(vars.key) ? [rows.get(vars.key)] : []),
        );
      return Response.json(surrealOk([]));
    }),
  );
  return rows;
}

const memoryStore = () => {
  const rows = new Map<string, unknown>();
  return {
    rows,
    get: async (key: string) => rows.get(key),
    put: async (key: string, value: unknown) => void rows.set(key, value),
  };
};

const env = (orchestrator?: Fetcher): ExampleEnv => ({
  ORCHESTRATOR: orchestrator,
  OPERATOR_TOKEN: "op-token",
  SURREALDB_URL: "https://db.example.test",
  SURREALDB_NAMESPACE: "reversy",
  SURREALDB_DATABASE: "main",
  SURREALDB_USER: "user",
  SURREALDB_PASSWORD: "pass",
});

const request = (path: string, init: RequestInit = {}) =>
  new Request(`https://reversy.test${path}`, init);
const save = (headers: Record<string, string> = {}, runId = RUN) =>
  request("/api/v1/example", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ runId }),
  });

afterEach(() => vi.unstubAllGlobals());

describe("example snapshot", () => {
  it("exports only effective media after replacements", async () => {
    for (const kind of ["screenshot", "recording", "not_observed"]) {
      const effective = {
        seq: 8,
        ts: events[0]!.ts,
        type: "evidence",
        data: {
          id: "ev_001",
          kind: kind === "not_observed" ? "screenshot" : kind,
          status: kind === "not_observed" ? "not_observed" : "observed",
          url:
            kind === "not_observed"
              ? undefined
              : `/runs/${RUN}/evidence/ev_001`,
        },
      };
      const updatedEvents = [...events, effective];
      const seen: string[] = [];
      const bytes = new Uint8Array([7, 8, 9]);
      const fetcher = {
        fetch: async (url: string) => {
          const path = new URL(url).pathname;
          seen.push(path);
          if (path === `/runs/${RUN}`) return Response.json(state());
          if (path === `/runs/${RUN}/events`)
            return Response.json(updatedEvents);
          if (
            path === `/runs/${RUN}/evidence/ev_001` &&
            kind !== "not_observed"
          )
            return new Response(bytes, {
              headers: {
                "content-type":
                  kind === "recording" ? "video/mp4" : "image/png",
              },
            });
          return new Response("not found", { status: 404 });
        },
      } as unknown as Fetcher;
      const { snapshot, files } = await exportRun(fetcher, RUN);
      expect(snapshot.media).toEqual(kind === "not_observed" ? [] : ["ev_001"]);
      expect(seen.filter((path) => path.includes("/evidence/"))).toEqual(
        kind === "not_observed" ? [] : [`/runs/${RUN}/evidence/ev_001`],
      );
      const store = memoryStore();
      await saveSnapshot(store, snapshot, files);
      const file = await loadMedia(store, RUN, "ev_001");
      expect(file?.bytes).toEqual(kind === "not_observed" ? undefined : bytes);
    }
  });
  it("round-trips a finished run's events and media, without the sandbox", async () => {
    const { fetcher } = fakeOrchestrator();
    const { snapshot, files } = await exportRun(
      fetcher,
      RUN,
      new Date("2026-10-16T21:00:00Z"),
    );
    const store = memoryStore();
    await saveSnapshot(store, snapshot, files);

    const loaded = await loadSnapshot(store);
    expect(loaded).toMatchObject({
      runId: RUN,
      target: "https://www.daytona.io/",
      phase: "done",
      finishedAt: "2026-10-16T19:11:27.000Z",
      savedAt: "2026-10-16T21:00:00.000Z",
      media: ["ev_001"],
    });
    expect(loaded?.events).toHaveLength(6);
    const text = JSON.stringify(loaded);
    expect(text).not.toContain(SANDBOX);
    expect(text).not.toContain("sandboxId");
    expect(text).not.toContain("signedtoken123");
    expect(text).toContain("Checked [not kept] ok");

    // 3 MiB is stored in two chunks and read back byte for byte.
    expect(store.rows.has(`file/${RUN}/ev_001/1`)).toBe(true);
    if (!loaded) throw new Error("no snapshot");
    const file = await loadMedia(store, loaded.runId, "ev_001");
    expect(file?.contentType).toBe("image/png");
    expect(Buffer.from(file?.bytes ?? []).equals(png)).toBe(true);
    expect(await loadMedia(store, loaded.runId, "ev_002")).toBeNull();
  });

  it("refuses a run that is still going", async () => {
    await expect(
      exportRun(fakeOrchestrator("building").fetcher, RUN),
    ).rejects.toMatchObject({ status: 409, code: "run_not_finished" });
  });

  it("refuses a run the orchestrator does not know", async () => {
    await expect(
      exportRun(fakeOrchestrator().fetcher, "other-run"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("example routes", () => {
  it("saves with the operator token, then serves the example to anyone", async () => {
    fakeSurreal();
    const e = env(fakeOrchestrator().fetcher);
    const saved = await handleExample(
      save({ authorization: "Bearer op-token" }),
      e,
    );
    expect(saved?.status).toBe(200);

    const example = await handleExample(request("/api/v1/example"), e);
    expect(example?.status).toBe(200);
    expect(await example?.json()).toMatchObject({ runId: RUN });

    const media = await handleExample(
      request(`/api/v1/example/${RUN}/evidence/ev_001`),
      e,
    );
    expect(media?.headers.get("content-type")).toBe("image/png");
    expect(media?.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from((await media?.arrayBuffer()) ?? []).equals(png)).toBe(
      true,
    );
  });

  it("keeps replaced media readable and isolates reused evidence IDs by run", async () => {
    fakeSurreal();
    const replacement = "replacement-run";
    const replacementBytes = new Uint8Array([9, 8, 7]);
    for (const [runId, bytes] of [
      [RUN, png],
      [replacement, replacementBytes],
    ] as const) {
      const response = await handleExample(
        save({ authorization: "Bearer op-token" }, runId),
        env(fakeOrchestrator("done", runId, bytes).fetcher),
      );
      expect(response?.status).toBe(200);
    }

    const current = await handleExample(request("/api/v1/example"), env());
    expect(await current?.json()).toMatchObject({ runId: replacement });
    for (const [runId, bytes] of [
      [RUN, png],
      [replacement, replacementBytes],
    ] as const) {
      const response = await handleExample(
        request(`/api/v1/example/${runId}/evidence/ev_001`),
        env(),
      );
      expect(response?.status).toBe(200);
      expect(response?.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(
        Buffer.from((await response?.arrayBuffer()) ?? []).equals(bytes),
      ).toBe(true);
      const missing = await handleExample(
        request(`/api/v1/example/${runId}/evidence/ev_002`),
        env(),
      );
      expect(missing?.status).toBe(404);
    }
    const unknown = await handleExample(
      request("/api/v1/example/unsaved-run/evidence/ev_001"),
      env(),
    );
    expect(unknown?.status).toBe(404);
    expect(
      await handleExample(request("/api/v1/example/evidence/ev_001"), env()),
    ).toBeNull();
  });

  it("refuses to save without the operator token", async () => {
    fakeSurreal();
    const { fetcher, seen } = fakeOrchestrator();
    const response = await handleExample(save(), env(fetcher));
    expect(response?.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("is read-only for everything but saving", async () => {
    fakeSurreal();
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const response = await handleExample(
        request("/api/v1/example", { method }),
        env(),
      );
      expect(response?.status).toBe(405);
    }
    const media = await handleExample(
      request(`/api/v1/example/${RUN}/evidence/ev_001`, { method: "POST" }),
      env(),
    );
    expect(media?.status).toBe(405);
  });

  it("answers 404 before anything is saved", async () => {
    fakeSurreal();
    const response = await handleExample(request("/api/v1/example"), env());
    expect(response?.status).toBe(404);
  });

  it("leaves the example's run itself behind run ownership", async () => {
    fakeSurreal();
    const { fetcher, seen } = fakeOrchestrator();
    for (const action of ["messages", "approve", "build", "stop"]) {
      const response = await worker.fetch(
        request(`/api/v1/runs/${RUN}/${action}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://reversy.test",
          },
          body: "{}",
        }),
        env(fetcher) as never,
      );
      expect(response.status).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it("ignores other paths", async () => {
    expect(await handleExample(request("/api/v1/examples"), env())).toBeNull();
  });
});
