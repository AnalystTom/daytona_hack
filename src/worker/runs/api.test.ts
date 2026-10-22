import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../../shared/contracts";
import { ApiError } from "../../shared/runs";
import { runBridgeToken } from "../daytona/bridge-token";
import { MemoryRunStore } from "../store/memory";
import type { RunStore } from "../store/types";
import { handleRunsApi, type RunsEnv } from "./api";

const env: RunsEnv = {
  BRIDGE_TOKEN: "bridge-secret",
  OPERATOR_TOKEN: "operator-secret",
};
const bridge = { authorization: "Bearer bridge-secret" };
const bridgeFor = async (runId: string) => ({
  authorization: `Bearer ${await runBridgeToken("bridge-secret", runId)}`,
});
const operator = { authorization: "Bearer operator-secret" };
const memoryStore = new MemoryRunStore();
const fast = { pollMs: 5, heartbeatMs: 1000, maxMs: 5000 };

const call = (
  path: string,
  init: RequestInit & { json?: unknown } = {},
  callEnv: RunsEnv = env,
  store: RunStore | null = memoryStore,
) => {
  const { json, ...rest } = init;
  const body = json === undefined ? rest.body : JSON.stringify(json);
  return handleRunsApi(
    new Request(`https://reversy.test/api/v1${path}`, { ...rest, body }),
    callEnv,
    fast,
    store ?? undefined,
  );
};

const createRun = async () => {
  const response = await call("/runs", {
    method: "POST",
    headers: operator,
    json: { url: "https://example.com", goal: "Rebuild the landing page" },
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { runId: string }).runId;
};

const envelope = (
  runId: string,
  eventId: string,
  extra: Partial<EventEnvelope> = {},
): EventEnvelope => ({
  schemaVersion: 1,
  eventId,
  sequence: 0,
  runId,
  timestamp: "2026-10-16T12:00:00.000+02:00",
  type: "task.status",
  state: "building",
  message: eventId,
  artifactRefs: [],
  ...extra,
});

const postEvents = async (
  runId: string,
  json: unknown,
  headers?: Record<string, string>,
) =>
  call(`/runs/${runId}/events`, {
    method: "POST",
    headers: headers ?? (await bridgeFor(runId)),
    json,
  });

const expectError = async (
  response: Response,
  status: number,
  code: string,
) => {
  expect(response.status).toBe(status);
  const body = ApiError.parse(await response.json());
  expect(body.code).toBe(code);
  return body;
};

// Reads server-sent events until `count` have arrived, then closes the stream.
const readEvents = async (response: Response, count: number) => {
  const reader = (response.body as ReadableStream<Uint8Array>)
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let text = "";
  const frames = () =>
    text.split("\n\n").filter((frame) => frame.includes("data: "));
  while (frames().length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
  }
  await reader.cancel();
  return frames().map((frame) => {
    const id = frame.match(/^id: (\d+)$/m)?.[1];
    const data = frame.match(/^data: (.*)$/m)?.[1] as string;
    return { id: Number(id), event: JSON.parse(data) as EventEnvelope };
  });
};

describe("run API configuration", () => {
  it("answers 503 naming every missing SurrealDB binding", async () => {
    const response = await call("/runs/x", {}, {}, null);
    const body = await expectError(response, 503, "not_configured");
    expect(body.message).toBe(
      "Missing Worker bindings: DB.",
    );
    expect(body.retryable).toBe(false);
  });

  it("uses the Cloudflare ray ID as the request ID", async () => {
    const response = await call("/nope", { headers: { "cf-ray": "ray-1" } });
    const body = await expectError(response, 404, "not_found");
    expect(body.requestId).toBe("ray-1");
  });
});

describe("POST /runs", () => {
  it("creates a run and announces it on the event stream", async () => {
    const runId = await createRun();
    const response = await call(`/runs/${runId}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      run: { url: string; status: string };
    };
    expect(body).toMatchObject({
      run: { url: "https://example.com/", status: "active" },
      tasks: [],
    });
    const [created] = await readEvents(await call(`/runs/${runId}/events`), 1);
    expect(created?.event).toMatchObject({
      type: "run.created",
      sequence: 1,
      message: "Rebuild the landing page",
    });
  });

  it.each([
    ["https://user:pw@example.com", "credentials"],
    ["http://example.com", "https"],
    ["https://192.168.0.10", "public host"],
    ["https://localhost:8443", "public host"],
  ])("rejects %s", async (url, reason) => {
    const response = await call("/runs", {
      method: "POST",
      headers: operator,
      json: { url, goal: "x" },
    });
    const body = await expectError(response, 400, "invalid_url");
    expect(body.message).toContain(reason);
  });

  it("rejects a missing goal and malformed JSON", async () => {
    await expectError(
      await call("/runs", {
        method: "POST",
        headers: operator,
        json: { url: "https://example.com", goal: " " },
      }),
      400,
      "invalid_request",
    );
    await expectError(
      await call("/runs", { method: "POST", headers: operator, body: "{" }),
      400,
      "invalid_json",
    );
    await expectError(
      await call("/runs", {
        method: "POST",
        headers: operator,
        body: "x".repeat(1_000_001),
      }),
      413,
      "payload_too_large",
    );
    await expectError(
      await call("/runs", {
        method: "POST",
        headers: { ...operator, "content-length": "2000000" },
        body: "{}",
      }),
      413,
      "payload_too_large",
    );
  });

  it("requires the OPERATOR_TOKEN binding and the right token", async () => {
    const json = { url: "https://example.com", goal: "x" };
    const missing = await call(
      "/runs",
      { method: "POST", headers: operator, json },
      { BRIDGE_TOKEN: "bridge-secret" },
    );
    const body = await expectError(missing, 503, "not_configured");
    expect(body.message).toContain("OPERATOR_TOKEN");
    await expectError(
      await call("/runs", { method: "POST", json }),
      401,
      "unauthorized",
    );
    await expectError(
      await call("/runs", { method: "POST", headers: bridge, json }),
      401,
      "unauthorized",
    );
  });

  it("answers 404 for an unknown run", async () => {
    await expectError(await call("/runs/missing"), 404, "run_not_found");
  });
});

describe("chat, approval and stop", () => {
  it("records a chat message as an event", async () => {
    const runId = await createRun();
    const response = await call(`/runs/${runId}/messages`, {
      method: "POST",
      json: { text: "Only the landing page, please" },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      event: { type: "chat.message", sequence: 2, state: "active" },
    });
  });

  it("approves the spec, stops once, then refuses chat", async () => {
    const runId = await createRun();
    const approved = await call(`/runs/${runId}/approve-spec`, {
      method: "POST",
    });
    expect(approved.status).toBe(200);
    const { run } = (await approved.json()) as {
      run: { specApprovedAt: string | null };
    };
    expect(run.specApprovedAt).not.toBeNull();

    for (let i = 0; i < 2; i++) {
      const stopped = await call(`/runs/${runId}/stop`, { method: "POST" });
      expect(await stopped.json()).toMatchObject({
        run: { status: "stopped" },
      });
    }
    await expectError(
      await call(`/runs/${runId}/messages`, {
        method: "POST",
        json: { text: "hello" },
      }),
      409,
      "run_stopped",
    );

    const events = await readEvents(await call(`/runs/${runId}/events`), 3);
    expect(events.map((e) => e.event.type)).toEqual([
      "run.created",
      "spec.approved",
      "run.stopped",
    ]);
  });
});

describe("bridge events", () => {
  it("requires the BRIDGE_TOKEN binding and the right token", async () => {
    const runId = await createRun();
    const missing = await call(
      `/runs/${runId}/events`,
      { method: "POST", headers: bridge, json: envelope(runId, "a") },
      { OPERATOR_TOKEN: "operator-secret" },
    );
    const body = await expectError(missing, 503, "not_configured");
    expect(body.message).toContain("BRIDGE_TOKEN");
    await expectError(
      await postEvents(runId, envelope(runId, "a"), {
        authorization: "Bearer wrong",
      }),
      401,
      "unauthorized",
    );
    await expectError(
      await postEvents(runId, envelope(runId, "a"), bridge),
      401,
      "unauthorized",
    );
    const otherRun = await createRun();
    await expectError(
      await postEvents(runId, envelope(runId, "a"), await bridgeFor(otherRun)),
      401,
      "unauthorized",
    );
    expect(
      (await postEvents(runId, envelope(runId, "a"), await bridgeFor(runId)))
        .status,
    ).toBeLessThan(300);
  });

  it("validates envelopes against the shared contract and the run", async () => {
    const runId = await createRun();
    await expectError(
      await postEvents(runId, { ...envelope(runId, "a"), schemaVersion: 2 }),
      400,
      "invalid_request",
    );
    await expectError(
      await postEvents(runId, envelope("other-run", "a")),
      400,
      "run_mismatch",
    );
  });

  it("stores a batch in producer order and ignores duplicate event IDs", async () => {
    const runId = await createRun();
    const first = await postEvents(runId, [
      envelope(runId, "late", {
        sequence: 20,
        taskId: "t1",
        state: "in_review",
      }),
      envelope(runId, "early", { sequence: 10, taskId: "t1" }),
    ]);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      stored: EventEnvelope[];
      duplicates: string[];
    };
    expect(firstBody.stored.map((e) => [e.eventId, e.sequence])).toEqual([
      ["early", 2],
      ["late", 3],
    ]);

    const again = await postEvents(runId, envelope(runId, "early"));
    expect(await again.json()).toEqual({ stored: [], duplicates: ["early"] });

    const { tasks } = (await (await call(`/runs/${runId}`)).json()) as {
      tasks: unknown[];
    };
    expect(tasks).toEqual([
      {
        taskId: "t1",
        state: "in_review",
        updatedAt: "2026-10-16T12:00:00.000+02:00",
        lastEventId: "late",
      },
    ]);
  });
});

describe("GET /runs/:id/events", () => {
  it("replays after Last-Event-ID and then streams new events", async () => {
    const runId = await createRun();
    await postEvents(runId, [envelope(runId, "a"), envelope(runId, "b")]);

    const replay = await readEvents(
      await call(`/runs/${runId}/events`, {
        headers: { "last-event-id": "2" },
      }),
      1,
    );
    expect(replay.map((e) => [e.id, e.event.eventId])).toEqual([[3, "b"]]);

    const live = call(`/runs/${runId}/events`, {
      headers: { "last-event-id": "3" },
    }).then((response) => readEvents(response, 1));
    await postEvents(runId, envelope(runId, "c"));
    expect((await live).map((e) => [e.id, e.event.eventId])).toEqual([
      [4, "c"],
    ]);
  });

  it("rejects a Last-Event-ID that is not a sequence number", async () => {
    const runId = await createRun();
    await expectError(
      await call(`/runs/${runId}/events`, {
        headers: { "last-event-id": "abc" },
      }),
      400,
      "invalid_last_event_id",
    );
  });
});

describe("Agent Memory", () => {
  it("writes and reads observations and decisions with sources", async () => {
    const runId = await createRun();
    const runBridge = await bridgeFor(runId);
    const write = (json: unknown, headers = runBridge) =>
      call(`/runs/${runId}/memory`, { method: "POST", headers, json });
    expect(
      (
        await write({
          kind: "observation",
          content: "Nav collapses below 768px",
          sources: ["ev-1"],
        })
      ).status,
    ).toBe(201);
    await write({
      kind: "decision",
      content: "Build nav first",
      sources: ["ev-1", "ev-2"],
    });
    await expectError(
      await write({ kind: "decision", content: "No sources", sources: [] }),
      400,
      "invalid_request",
    );
    await expectError(
      await write(
        { kind: "decision", content: "x", sources: ["a"] },
        {
          authorization: "Bearer wrong",
        },
      ),
      401,
      "unauthorized",
    );

    await expectError(
      await call(`/runs/${runId}/memory?kind=decision`, { headers: bridge }),
      401,
      "unauthorized",
    );
    const read = await call(`/runs/${runId}/memory?kind=decision`, {
      headers: runBridge,
    });
    expect(await read.json()).toMatchObject({
      entries: [
        {
          kind: "decision",
          content: "Build nav first",
          sources: ["ev-1", "ev-2"],
        },
      ],
    });
    await expectError(
      await call(`/runs/${runId}/memory?kind=nope`, { headers: runBridge }),
      400,
      "invalid_request",
    );
  });
});
