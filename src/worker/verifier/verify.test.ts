import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../index";

// Test fixtures only: a minimal evidence pack, plan and mocked Nicrron responses.
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

const modelReply = (text: string, finishReason = "stop") =>
  Response.json({
    model: "anthropic/claude-opus-5-5",
    choices: [
      {
        message: { role: "assistant", content: text },
        finish_reason: finishReason,
      },
    ],
  });

const mockModel = (response: Response) => {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const env = { NICRRON_API_KEY: "test-key", VERIFIER_TOKEN: "test-token" };

const callVerify = (
  body: unknown,
  bindings: object = env,
  authorization = "Bearer test-token",
) =>
  worker.fetch(
    new Request("https://reversy.test/api/v1/runs/run_1/verify", {
      method: "POST",
      headers: { authorization },
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
  it.each([
    ["VERIFIER_TOKEN", { NICRRON_API_KEY: "test-key" }],
    ["NICRRON_API_KEY", { VERIFIER_TOKEN: "test-token" }],
  ])(
    "returns 503 naming a missing %s without calling the model",
    async (name, bindings) => {
      const fetchMock = mockModel(modelReply("{}"));
      const response = await callVerify(planBody, bindings);
      expect(response.status).toBe(503);
      expect(await errorOf(response)).toContain(name);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["no header", ""],
    ["a wrong token", "Bearer wrong-token"],
    ["a token prefix", "Bearer test-tok"],
    ["the token without Bearer", "test-token"],
  ])(
    "returns 401 for %s without calling the model",
    async (_, authorization) => {
      const fetchMock = mockModel(modelReply("{}"));
      const response = await callVerify(planBody, env, authorization);
      expect(response.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    ["an unknown task plan item", { planItemIds: ["feat_missing"] }],
    ["an unknown task evidence ID", { evidenceIds: ["ev_missing"] }],
    [
      "an unknown task rebuild evidence ID",
      { rebuildEvidenceIds: ["ev_missing"] },
    ],
  ])("returns 400 for %s without calling the model", async (_, patch) => {
    const fetchMock = mockModel(modelReply("{}"));
    const body = { ...taskBody, task: { ...taskBody.task, ...patch } };
    expect((await callVerify(body)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown final rebuild evidence ID without calling the model", async () => {
    const fetchMock = mockModel(modelReply("{}"));
    const body = {
      ...planBody,
      kind: "final",
      rebuildEvidenceIds: ["ev_missing"],
    };
    expect((await callVerify(body)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a plan item citing unknown evidence so the model can report it", async () => {
    const fetchMock = mockModel(
      modelReply(
        JSON.stringify({
          verdict: "fail",
          summary: "Missing evidence.",
          findings: [
            { planItemId: "feat_hero", evidenceIds: ["ev_gone"], message: "x" },
          ],
        }),
      ),
    );
    const body = {
      ...planBody,
      plan: [{ ...planBody.plan[0], evidenceIds: ["ev_gone"] }],
    };
    const response = await callVerify(body);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("calls Nicrron at high effort with structured output and returns a pass", async () => {
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
      model: "anthropic/claude-opus-5-5",
      verdict: "pass",
      summary: "Plan traces.",
      findings: [],
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.nicrron.ai/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer test-key",
    );
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe("nicrron/auto");
    expect(sent.reasoning_effort).toBe("high");
    expect(sent.response_format.type).toBe("json_schema");
    expect(sent.messages[1].content).toContainEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0K" },
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

  it.each(["length", "content_filter"])(
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
        { error: { message: "invalid api key", code: 401 } },
        { status: 401 },
      ),
    );
    const response = await callVerify(planBody);
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toContain("Verifier model call failed");
  });
});
