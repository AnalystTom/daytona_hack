import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { Daytona } from "./daytona";
import { inspectBackend } from "./inspect";
import type { Env, Evidence, Task } from "./types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

const { Run } = await import("./run");

const SITE = "https://site.example/insights/article";
const HTML = `<html><head>
<script src="/static/app.js"></script>
<script type="application/ld+json">{"@type":"Article","headline":"x","author":{"name":"y"}}</script>
</head><body><a href="/insights">Insights</a><script>fetch("/api/v1/articles?id=1")</script></body></html>`;

// Durable Object storage in a Map: enough for one Run.
function context() {
  const store = new Map<string, unknown>();
  const storage = {
    get: async (k: string) => store.get(k),
    put: async (k: string, v: unknown) => void store.set(k, v),
    list: async ({ prefix }: { prefix: string }) =>
      new Map([...store].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const ctx = {
    storage,
    ready: Promise.resolve(),
    // the runtime holds requests until this settles; tests await `ready` instead
    blockConcurrencyWhile: (fn: () => Promise<void>) => {
      ctx.ready = fn();
    },
    waitUntil: () => {},
  };
  return ctx;
}

type Call = {
  name: string;
  instructions: string;
  input: { evidence: Evidence[] };
};

// Stubs the model (one canned answer per prompt name) and the target site.
function stubFetch(answers: Record<string, unknown[]>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (input === "https://api.openai.com/v1/responses") {
      const body = JSON.parse(String(init?.body));
      const name = body.text.format.name;
      calls.push({
        name,
        instructions: body.instructions,
        input: JSON.parse(body.input),
      });
      const queue = answers[name] ?? [
        { pass: true, summary: "ok", findings: [] },
      ];
      return Response.json({ output_text: JSON.stringify(queue.shift()) });
    }
    if (input.startsWith(SITE))
      return new Response(HTML, {
        headers: { "content-type": "text/html", "cache-control": "max-age=60" },
      });
    return new Response("missing", { status: 404 });
  });
  return calls;
}

const turn = (scope: string, userApproved: boolean) => ({
  reply: userApproved ? "Approved." : "Which routes matter?",
  userApproved,
  spec: {
    scope,
    pages: [
      { path: "/insights/article", confirmed: true, notes: "" },
      { path: "//elsewhere.example/x", confirmed: true, notes: "" },
    ],
    flows: [],
    openQuestions: [],
  },
});

const task = (id: string, owns: string[], dependsOn: string[] = []) => ({
  id,
  title: id,
  brief: "b",
  outOfScope: "o",
  acceptance: ["a"],
  evidence: [],
  owns,
  dependsOn,
});

async function plannedRun(scope: string, goal: string, tasks: unknown[]) {
  const calls = stubFetch({
    orchestrator_turn: [turn(scope, false), turn(scope, true)],
    plan: [{ tasks }],
    review: [{ verdict: "approve", reason: "ok", findings: [] }],
  });
  const ctx = context();
  const run = new Run(
    ctx as unknown as DurableObjectState,
    {
      ORCHESTRATOR_MODEL: "m",
    } as Env,
  );
  await ctx.ready;
  await run.start("run-1", SITE, goal);
  await run.message("Yes, go ahead.");
  await run.alarm();
  return { state: await run.getState(), calls, run };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("run scope", () => {
  it.each(["frontend", "backend", "both"] as const)(
    "requires observed content and explicit unavailable states in emitted %s agent contracts",
    async (scope) => {
      // All sandbox work and model answers are test doubles; no paid run starts.
      vi.spyOn(Daytona.prototype, "create").mockResolvedValue({ id: "test" });
      vi.spyOn(Daytona.prototype, "must").mockResolvedValue("");
      vi.spyOn(Daytona.prototype, "startAsync").mockResolvedValue("cmd");
      const uploads = vi
        .spyOn(Daytona.prototype, "writeFile")
        .mockResolvedValue();
      vi.spyOn(Daytona.prototype, "previewUrl").mockResolvedValue(
        "https://preview.example/",
      );
      vi.spyOn(Daytona.prototype, "signedPreviewUrl").mockResolvedValue(
        "https://preview.example/",
      );
      const owned =
        scope === "frontend"
          ? "sections/articles.html"
          : "server/routes/articles.js";
      vi.spyOn(Daytona.prototype, "exec").mockImplementation(
        async (_id, command) => ({
          exitCode: 0,
          result: command.startsWith("cat ")
            ? "0"
            : command.includes("--name-only")
              ? owned
              : "submitted diff",
        }),
      );
      const { run, calls } = await plannedRun(
        scope,
        "Rebuild from the available evidence.",
        [{ ...task("t01", [owned]), evidence: ["ev_002"] }],
      );
      await run.startBuild();
      await run.alarm(); // isolated sandbox setup
      await run.alarm(); // dispatch: worker prompt uploaded
      await run.alarm(); // review, task verification and final verification
      expect((await run.getState()).phase).toBe("done");
      expect((await run.getState()).tasks[0].status).toBe("merged");

      // These are the actual model requests and sandbox prompt file, not source text.
      expect(calls.map((call) => call.name)).toEqual([
        "orchestrator_turn",
        "orchestrator_turn",
        "plan",
        "verify_plan",
        "review",
        "verify_task",
        "verify_final",
      ]);
      const workerPrompt = uploads.mock.calls.find(([, path]) =>
        path.endsWith("t01.prompt.md"),
      )?.[2];
      expect(workerPrompt).toEqual(expect.any(String));
      for (const instructions of [
        ...calls.map((call) => call.instructions),
        String(workerPrompt),
      ]) {
        expect(instructions).toContain(
          "Use only observed real application data",
        );
        expect(instructions).toContain(
          "A response shape or inferred route is not evidence for content values",
        );
        expect(instructions).toContain(
          "explicit loading, empty, unavailable or error state",
        );
        expect(instructions).toContain(
          "Do not expand capture to collect private values",
        );
        expect(instructions).toContain("Reject invented content values");
        expect(instructions).not.toMatch(
          /with mock data|mock data in the response shape/,
        );
      }
      const review = calls.find((call) => call.name === "review");
      assert(review);
      expect(review.input.evidence).toEqual(
        (await run.getState()).evidence.filter((e) => e.id === "ev_002"),
      );
      expect(review.input.evidence).toHaveLength(1);
      if (scope !== "frontend") {
        const plan = calls.find((call) => call.name === "plan");
        assert(plan);
        expect(plan.instructions).toContain(
          'HTTP 503 with {"error":"Data unavailable","status":"not_observed"}',
        );
        expect(plan.instructions).not.toContain("server/mock/NAME.json");
        expect(String(workerPrompt)).toContain(
          'HTTP 503 with {"error":"Data unavailable","status":"not_observed"}',
        );
      }
    },
  );

  it("keeps a backend-only brief backend only, from spec to plan", async () => {
    const { state, calls, run } = await plannedRun(
      "backend",
      "Do not copy the frontend; reverse engineer the backend only.",
      [
        task("t01", ["server/server.js"]),
        task(
          "t02",
          ["server/routes/articles.js", "server/mock/article.html"],
          ["t01"],
        ),
        task("t03", ["server/routes/search.js"], ["t01", "t02"]),
      ],
    );
    expect(state.phase).toBe("planned");
    expect(state.spec.scope).toBe("backend");

    const chat = calls.find((c) => c.name === "orchestrator_turn");
    expect(chat?.instructions).toMatch(/"backend"/);
    const plan = calls.find((c) => c.name === "plan");
    expect(plan?.instructions).toContain("server/routes/NAME.js");
    expect(plan?.instructions).not.toContain("sections/NAME.html");
    expect(plan?.input.evidence).toContainEqual(
      expect.objectContaining({
        kind: "network",
        status: "inferred",
        routes: ["/api/v1/articles?id=1"],
      }),
    );
    expect(plan?.input.evidence).toContainEqual(
      expect.objectContaining({
        status: "observed",
        response: {
          status: 200,
          headers: {
            "content-type": "text/html",
            "cache-control": "max-age=60",
          },
        },
      }),
    );

    expect(state.tasks.map((t: Task) => t.id)).toEqual(["t01", "t02", "t03"]);
    expect(state.tasks.find((t: Task) => t.id === "t03")?.dependsOn).toEqual([
      "t01",
      "t02",
    ]);

    // a page path that leaves the run's site is never fetched
    expect(state.evidence.some((e: Evidence) => e.page === "/x")).toBe(false);

    // evidence: network observations, with honest labels; REA stays not observed
    const after = state.evidence.slice(2) as Evidence[];
    expect(after.some((e) => e.kind === "screenshot")).toBe(false);
    expect(after).toContainEqual(
      expect.objectContaining({ kind: "network", status: "observed" }),
    );
    expect(after).toContainEqual(
      expect.objectContaining({
        kind: "network",
        status: "inferred",
        summary: expect.stringContaining("1 API URLs referenced"),
        routes: ["/api/v1/articles?id=1"],
      }),
    );
    expect(after).toContainEqual(
      expect.objectContaining({
        kind: "code",
        tool: "rea",
        status: "not_observed",
      }),
    );
    expect((await run.startBuild()).phase).toBe("building");
  });

  it.each([
    {
      name: "mixed foundation",
      tasks: [
        task("t01", ["server/server.js", "index.html"]),
        task("t02", ["server/routes/articles.js"], ["t01"]),
      ],
    },
    {
      name: "mixed route prerequisite",
      tasks: [
        task("t01", ["server/server.js"]),
        task(
          "t02",
          ["server/routes/articles.js", "sections/hero.html"],
          ["t01"],
        ),
        task("t03", ["server/routes/search.js"], ["t01", "t02"]),
      ],
    },
    {
      name: "frontend prerequisite",
      tasks: [
        task("t01", ["server/server.js"]),
        task("t02", ["index.html"], ["t01"]),
        task("t03", ["server/routes/articles.js"], ["t01", "t02"]),
      ],
    },
  ])(
    "rejects a backend plan with a $name before accepting it",
    async ({ tasks }) => {
      const { state, calls, run } = await plannedRun(
        "backend",
        "Backend only.",
        tasks,
      );
      expect(state.phase).toBe("failed");
      expect(state.error).toContain("Plan rejected:");
      expect(state.tasks).toEqual([]);
      expect(calls.some((c) => c.name === "verify_plan")).toBe(false);
      expect((await run.events(0)).some((e) => e.type === "plan")).toBe(false);
      await expect(run.startBuild()).rejects.toThrow("No build started");
      expect((await run.getState()).sandboxId).toBeUndefined();
    },
  );

  it("still plans a frontend rebuild from a frontend brief", async () => {
    const { state, calls } = await plannedRun(
      "frontend",
      "Rebuild the home page.",
      [
        task("t01", ["index.html", "assets/"]),
        task("t02", ["sections/hero.html"], ["t01"]),
      ],
    );
    expect(state.spec.scope).toBe("frontend");
    expect(state.phase).toBe("planned");
    const plan = calls.find((c) => c.name === "plan");
    expect(plan?.instructions).toContain("sections/NAME.html");
    expect(plan?.instructions).not.toContain("server/routes");
    expect(state.tasks.map((t: Task) => t.id)).toEqual(["t01", "t02"]);
    expect(state.evidence.some((e: Evidence) => e.kind === "code")).toBe(false);
  });

  it("emits unrestricted chat and plan prompts for a combined run", async () => {
    const { state, calls } = await plannedRun("both", "Rebuild both layers.", [
      task("t01", ["index.html", "server/server.js"]),
    ]);
    expect(state.spec.scope).toBe("both");
    expect(state.phase).toBe("planned");
    for (const call of calls)
      expect(call.instructions).not.toMatch(
        /daytona\.io|create[- ]a?[- ]?sandbox|landing page|for this version/i,
      );
  });

  it("captures JSON response shapes without copying values or cookies", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json(
        { items: [{ id: 42, title: "private content" }] },
        {
          headers: {
            "set-cookie": "session=private",
            "cache-control": "no-cache",
          },
        },
      ),
    );
    const { evidence, blobs } = await inspectBackend(SITE, 1);
    expect(evidence[0].response).toEqual({
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-cache",
      },
      shape: { items: [{ id: "number", title: "string" }] },
    });
    expect(JSON.stringify({ evidence, blobs })).not.toMatch(
      /session=private|private content/,
    );
  });
});
