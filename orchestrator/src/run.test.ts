import { afterEach, describe, expect, it, vi } from "vitest";
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
  return { state: await run.getState(), calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("run scope", () => {
  it("keeps a backend-only brief backend only, from spec to plan", async () => {
    const { state, calls } = await plannedRun(
      "backend",
      "Do not copy the frontend; reverse engineer the backend only.",
      [
        task("t01", ["server/server.js"]),
        task(
          "t02",
          ["server/routes/articles.js", "server/mock/article.html"],
          ["t01"],
        ),
        task("t03", ["sections/hero.html", "styles/hero.css"], ["t01"]),
        task("t04", ["server/routes/search.js"], ["t01", "t03"]),
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

    // the frontend task is dropped and nothing waits on it
    expect(state.tasks.map((t: Task) => t.id)).toEqual(["t01", "t02", "t04"]);
    expect(state.tasks.find((t: Task) => t.id === "t04")?.dependsOn).toEqual([
      "t01",
    ]);
    expect(state.chat.at(-2)?.text).toContain("Dropped t03");

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
  });

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
