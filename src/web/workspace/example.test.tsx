import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { workspaceRoute } from "../App";
import { Landing } from "../landing/Landing";
import { ExampleRun } from "./ExampleWorkspace";
import { type Example, exampleView, fetchExample } from "./example";
import { reportContractExample } from "../../shared/report.test-data";

const RUN = "03b191c5-e0dc-4f8b-aa97-2e8da09db3f0";
const task = (id: string, status: string) => ({
  id,
  title: `Task ${id}`,
  status,
  attempts: 1,
});
const example: Example = {
  runId: RUN,
  target: "https://www.daytona.io/",
  phase: "done",
  finishedAt: "2026-10-16T19:11:26.709Z",
  savedAt: "2026-10-16T21:00:00.000Z",
  events: [
    {
      seq: 1,
      ts: "2026-10-16T18:35:11.992Z",
      type: "phase",
      data: { phase: "brief" },
    },
    {
      seq: 2,
      ts: "2026-10-16T18:35:11.992Z",
      type: "chat",
      data: { role: "user", text: "https://www.daytona.io/ rebuild it" },
    },
    {
      seq: 3,
      ts: "2026-10-16T18:35:23.043Z",
      type: "evidence",
      data: {
        id: "ev_001",
        page: "/",
        kind: "screenshot",
        tool: "anchor",
        status: "observed",
        capturedAt: "2026-10-16T18:35:18.993Z",
        hash: "8fb85217c0d0405f",
        limits: "desktop 1440px",
        url: `/runs/${RUN}/evidence/ev_001`,
      },
    },
    {
      seq: 4,
      ts: "2026-10-16T18:36:00.000Z",
      type: "chat",
      data: { role: "assistant", text: "Plan ready." },
    },
    {
      seq: 5,
      ts: "2026-10-16T18:46:27.718Z",
      type: "plan",
      data: {
        tasks: [
          task("t01", "queued"),
          task("t02", "queued"),
          task("t03", "queued"),
        ],
      },
    },
    {
      seq: 6,
      ts: "2026-10-16T18:46:30.564Z",
      type: "phase",
      data: { phase: "building" },
    },
    {
      seq: 7,
      ts: "2026-10-16T19:00:00.000Z",
      type: "task",
      data: task("t01", "merged"),
    },
    {
      seq: 8,
      ts: "2026-10-16T19:02:00.000Z",
      type: "task",
      data: { ...task("t02", "failed"), failure: "no changes submitted" },
    },
    {
      seq: 9,
      ts: "2026-10-16T19:11:26.709Z",
      type: "phase",
      data: { phase: "done" },
    },
  ],
};

describe("fetchExample", () => {
  it("reads the saved example without any token", async () => {
    let seen: RequestInit | undefined;
    const result = await fetchExample(async (_url, init) => {
      seen = init;
      return Response.json(example);
    });
    expect(result).toEqual({ ok: true, value: example });
    expect(seen).toBeUndefined();
  });

  it("reports a missing example and an unreachable server", async () => {
    const missing = await fetchExample(async () =>
      Response.json({ code: "no_example" }, { status: 404 }),
    );
    expect(missing).toMatchObject({ ok: false, error: "not_found" });
    const offline = await fetchExample(async () => {
      throw new TypeError("offline");
    });
    expect(offline).toMatchObject({ ok: false, error: "not_connected" });
  });
});

describe("exampleView", () => {
  it("serves screenshots from the saved copy and replays the whole chat", () => {
    const { run, entries } = exampleView(example);
    expect(run.evidence.map((e) => e.src)).toEqual([
      `/api/v1/example/${RUN}/evidence/ev_001`,
    ]);
    expect(entries.map((e) => e.kind)).toEqual(["user", "agent"]);
  });

  it.each(["screenshot", "recording"])(
    "scopes %s URLs to each saved run",
    (kind) => {
      for (const runId of [RUN, "replacement-run"]) {
        const source = {
          ...example,
          runId,
          events: example.events.map((event) =>
            event.type === "evidence"
              ? {
                  ...event,
                  data: {
                    ...(event.data as Record<string, unknown>),
                    kind,
                    url: `/runs/${runId}/evidence/ev_001`,
                  },
                }
              : event,
          ),
        };
        expect(exampleView(source).run.evidence).toMatchObject([
          { kind, src: `/api/v1/example/${runId}/evidence/ev_001` },
        ]);
      }
    },
  );

  it("counts tasks that never ran as never started", () => {
    expect(exampleView(example).outcome).toBe(
      "1 merged, 1 failed, 1 never started",
    );
  });
});

describe("ExampleRun", () => {
  it("renders a saved report and its provenance without a draft or screenshot", () => {
    const savedReport: Example = {
      ...example,
      events: [
        {
          seq: 1,
          ts: example.savedAt,
          type: "report",
          data: reportContractExample,
        },
      ],
    };
    const html = renderToStaticMarkup(<ExampleRun example={savedReport} />);
    expect(html).toContain("Report dissection");
    expect(html).toContain("$581 billion");
    expect(html).toContain("including $581 billion in the US");
    expect(html).toContain("report_run");
    expect(html).not.toContain("Your work starts here");
    expect(html).not.toContain("Save changes");
  });
  const html = renderToStaticMarkup(<ExampleRun example={example} />);

  it("labels the run as a saved example with its date and run id", () => {
    expect(html).toContain(
      "Example run: www.daytona.io, captured 16 Oct 2026, 19:11 UTC, run 03b191c5.",
    );
    expect(html).toContain("not a live session");
    expect(html).toContain("Start your own");
  });

  it("offers nothing that could steer, approve or build the run", () => {
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Start build");
    expect(html).toContain("This example is read-only.");
  });
});

describe("workspaceRoute", () => {
  it("opens the example on bare /workspace and /workspace/example", () => {
    expect(workspaceRoute("/workspace", undefined)).toBe("example");
    expect(workspaceRoute("/workspace/", undefined)).toBe("example");
    expect(workspaceRoute("/workspace/example", "s1")).toBe("example");
  });

  it("opens a session once one is started, and runs by id", () => {
    expect(workspaceRoute("/workspace", "s1")).toEqual({ runId: undefined });
    expect(workspaceRoute("/workspace", undefined, true)).toEqual({
      runId: undefined,
    });
    expect(workspaceRoute(`/workspace/${RUN}`, undefined)).toEqual({
      runId: RUN,
    });
    expect(workspaceRoute("/start", undefined)).toBeNull();
  });

  it("is where Start a project leads from the landing page", () => {
    const landing = renderToStaticMarkup(<Landing />);
    expect(landing).toMatch(/href="\/workspace"[^>]*>Start a project/);
  });
});
