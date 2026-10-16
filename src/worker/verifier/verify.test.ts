import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../index";

// Test fixtures only: a minimal evidence pack, plan and mocked Anthropic responses.
const evidenceItem = (id: string) => ({
  id,
  kind: "screenshot",
  label: "observed",
  pageOrState: "/ desktop",
  tool: "anchor",
  capturedAt: "2026-10-16T12:00:00Z",
  contentHash: `sha256:${id}`,
  limitations: [],
});

const planBody = {
  kind: "plan",
  spec: "Rebuild the landing page hero.",
  evidence: [evidenceItem("ev_1")],
  screenshots: [
    { evidenceId: "ev_1", mediaType: "image/png", data: "iVBORw0K" },
  ],
  plan: [
    {
      id: "feat_hero",
      title: "Hero section",
      acceptanceCriteria: ["Headline matches ev_1"],
      evidenceIds: ["ev_1"],
    },
  ],
};

const taskBody = {
  ...planBody,
  kind: "task",
  evidence: [evidenceItem("ev_1"), evidenceItem("ev_rebuild_1")],
  task: {
    id: "task_hero",
    title: "Build the hero",
    planItemIds: ["feat_hero"],
    acceptanceCriteria: ["Headline matches ev_1"],
    evidenceIds: ["ev_1"],
    rebuildEvidenceIds: ["ev_rebuild_1"],
  },
};

const modelReply = (text: string, stopReason = "end_turn") =>
  Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });

const mockModel = (response: Response) => {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const env = { ANTHROPIC_API_KEY: "test-key" };

const callVerify = (body: unknown, bindings: object = env) =>
  worker.fetch(
    new Request("https://reversy.test/api/v1/runs/run_1/verify", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    bindings,
  );

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: string }).error;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/v1/runs/:id/verify", () => {
  it("returns 503 naming the missing binding without calling the model", async () => {
    const fetchMock = mockModel(modelReply("{}"));
    const response = await callVerify(planBody, {});
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toContain("ANTHROPIC_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid request", async () => {
    mockModel(modelReply("{}"));
    expect((await callVerify({ ...planBody, kind: "vibes" })).status).toBe(400);
    const unknownShot = {
      ...planBody,
      screenshots: [
        { evidenceId: "ev_9", mediaType: "image/png", data: "AA==" },
      ],
    };
    expect((await callVerify(unknownShot)).status).toBe(400);
  });

  it("calls Opus 5.5 at high effort with structured output and returns a pass", async () => {
    const fetchMock = mockModel(
      modelReply(
        JSON.stringify({
          verdict: "pass",
          summary: "Plan traces.",
          findings: [],
        }),
      ),
    );
    const response = await callVerify(planBody);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runId: "run_1",
      kind: "plan",
      model: "claude-opus-5-5",
      verdict: "pass",
      summary: "Plan traces.",
      findings: [],
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(init.headers).get("x-api-key")).toBe("test-key");
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe("claude-opus-5-5");
    expect(sent.output_config.effort).toBe("high");
    expect(sent.output_config.format.type).toBe("json_schema");
    expect(sent.thinking).toBeUndefined();
    expect(sent.messages[0].content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0K" },
    });
  });

  it("returns a fail with findings tied to plan items and evidence", async () => {
    const findings = [
      {
        planItemId: "feat_hero",
        evidenceIds: ["ev_1", "ev_rebuild_1"],
        message: "Headline copy differs from the original.",
      },
    ];
    mockModel(
      modelReply(
        JSON.stringify({ verdict: "fail", summary: "Copy differs.", findings }),
      ),
    );
    const response = await callVerify(taskBody);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "task",
      verdict: "fail",
      findings,
    });
  });

  it.each([
    ["non-JSON text", "Looks good to me!"],
    [
      "a verdict outside the schema",
      JSON.stringify({ verdict: "maybe", summary: "Hmm", findings: [] }),
    ],
    [
      "a fail without findings",
      JSON.stringify({ verdict: "fail", summary: "Bad", findings: [] }),
    ],
    [
      "an unknown evidence ID",
      JSON.stringify({
        verdict: "fail",
        summary: "Bad",
        findings: [
          { planItemId: "feat_hero", evidenceIds: ["ev_404"], message: "x" },
        ],
      }),
    ],
    [
      "an unknown plan item",
      JSON.stringify({
        verdict: "fail",
        summary: "Bad",
        findings: [{ planItemId: "feat_x", evidenceIds: [], message: "x" }],
      }),
    ],
  ])("rejects malformed model output: %s", async (_, text) => {
    mockModel(modelReply(text));
    const response = await callVerify(planBody);
    expect(response.status).toBe(502);
    expect(await response.json()).not.toHaveProperty("verdict");
  });

  it.each(["max_tokens", "refusal"])(
    "reports a %s stop as an error, never a pass",
    async (stopReason) => {
      mockModel(
        modelReply(
          JSON.stringify({ verdict: "pass", summary: "ok", findings: [] }),
          stopReason,
        ),
      );
      const response = await callVerify(planBody);
      expect(response.status).toBe(502);
      expect(await errorOf(response)).toContain(stopReason);
    },
  );

  it("reports a model API error as an error, never a pass", async () => {
    mockModel(
      Response.json(
        {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        },
        { status: 401 },
      ),
    );
    const response = await callVerify(planBody);
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toContain("Verifier model call failed");
  });
});
