import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventEnvelope, TaskState } from "../../src/shared/contracts";
import {
  backlogObservations,
  pullRequestObservations,
  runCycle,
  statusObservations,
  toEnvelope,
} from "./bridge";

describe("bridge observations", () => {
  it("reads Firstmate status lines with their time and maps them to board states", () => {
    const observations = statusObservations(
      "hero",
      [
        "working [at=1792167459]: setup done",
        "needs-decision [at=1792167500] [key=nm-1-review]: ask-user findings=a1",
        "not a status line",
        "done [at=1792167600]: PR http://localhost:3000/reversy/rebuild/pulls/3 checks green",
        "failed [at=1792167700]: tests never passed",
      ].join("\n"),
    );
    expect(observations.map((o) => [o.state, o.message])).toEqual([
      ["building", "working: setup done"],
      ["building", "needs-decision: ask-user findings=a1"],
      [
        "in_review",
        "done: PR http://localhost:3000/reversy/rebuild/pulls/3 checks green",
      ],
      ["failed", "failed: tests never passed"],
    ]);
    expect(observations[0]?.timestamp).toBe("2026-10-16T16:17:39.000Z");
    expect(observations.every((o) => o.taskId === "hero")).toBe(true);
  });

  it("maps backlog sections to queued, building, merged and stopped", () => {
    const observations = backlogObservations(
      [
        "# Backlog",
        "## In flight",
        "- [ ] nav - Navigation bar (repo: rebuild) (kind: ship)",
        "- [ ] hero - Hero section blocked-by: foundation (repo: rebuild)",
        "## Queued",
        "- [ ] footer - Footer (repo: rebuild)",
        "## Done",
        "- [x] foundation - Skeleton and tokens (merged 2026-10-16)",
        "- [x] audit - Spike report (completed 2026-10-16)",
      ].join("\n"),
    );
    expect(observations.map((o) => [o.taskId, o.state])).toEqual([
      ["nav", "building"],
      ["hero", "queued"],
      ["footer", "queued"],
      ["foundation", "merged"],
      ["audit", "stopped"],
    ]);
  });

  it("ties pull requests to tasks through fm/ branches", () => {
    const observations = pullRequestObservations([
      {
        number: 3,
        title: "Hero section",
        state: "closed",
        merged: true,
        html_url: "http://localhost:3000/reversy/rebuild/pulls/3",
        head: { ref: "fm/hero" },
      },
      {
        number: 4,
        title: "Manual change",
        state: "open",
        merged: false,
        html_url: "http://localhost:3000/reversy/rebuild/pulls/4",
        head: { ref: "manual" },
      },
    ]);
    expect(observations).toMatchObject([
      { taskId: "hero", state: "merged", message: "#3 Hero section" },
      { taskId: undefined, state: "in_review" },
    ]);
  });

  it("builds valid shared envelopes with stable ids, tagging pod events", () => {
    const [observation] = statusObservations(
      "hero",
      "working [at=1792167459]: started",
    );
    if (!observation) throw new Error("no observation");
    const context = {
      runId: "run-1",
      sequence: 7,
      now: "2026-10-16T00:00:00Z",
    };
    const envelope = EventEnvelope.parse(toEnvelope(observation, context));
    expect(envelope).toMatchObject({ sequence: 7, taskId: "hero" });
    expect(TaskState.parse(envelope.state)).toBe("building");
    expect(toEnvelope(observation, context).eventId).toBe(envelope.eventId);
    const pod = toEnvelope(observation, { ...context, podId: "sb2" });
    expect(pod.eventId).not.toBe(envelope.eventId);
    expect(pod.artifactRefs).toEqual(["pod:sb2"]);
  });
});

describe("bridge cycle", () => {
  function sandboxHome() {
    const root = mkdtempSync(join(tmpdir(), "bridge-"));
    const stateDir = join(root, ".reversy");
    const fmHome = join(root, "firstmate");
    mkdirSync(join(stateDir, "env"), { recursive: true });
    mkdirSync(join(fmHome, "state"), { recursive: true });
    mkdirSync(join(fmHome, "data"), { recursive: true });
    const env = (name: string, value: string) =>
      writeFileSync(join(stateDir, "env", name), value);
    env("REVERSY_RUN_ID", "run-1");
    env("REVERSY_API_URL", "https://reversy.test");
    env("BRIDGE_TOKEN", "bridge-test");
    writeFileSync(join(stateDir, "forgejo-token"), "forgejo-test");
    writeFileSync(
      join(fmHome, "state", "hero.status"),
      "working [at=1792167459]: started\n",
    );
    writeFileSync(
      join(fmHome, "data", "backlog.md"),
      "## In flight\n- [ ] hero - Hero section\n",
    );
    return {
      fmHome,
      config: {
        stateDir,
        fmHome,
        forgejoUrl: "http://forgejo.test",
        forgejoRepo: "reversy/rebuild",
      },
    };
  }

  function fakeFetch(eventStatus = 200) {
    const posts: unknown[][] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("http://forgejo.test")) {
        expect(init?.headers).toEqual({ Authorization: "token forgejo-test" });
        return Response.json([
          {
            number: 1,
            title: "Hero",
            state: "open",
            merged: false,
            html_url: "http://forgejo.test/reversy/rebuild/pulls/1",
            head: { ref: "fm/hero" },
          },
        ]);
      }
      expect(url).toBe("https://reversy.test/api/v1/runs/run-1/events");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer bridge-test",
      });
      posts.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: eventStatus });
    });
    return { fetch: fetch as unknown as typeof globalThis.fetch, posts };
  }

  const now = () => "2026-10-16T12:00:00.000Z";

  it("posts new observations once, in sequence, and only changes afterwards", async () => {
    const { config, fmHome } = sandboxHome();
    const first = fakeFetch();
    expect(await runCycle(config, first.fetch, now)).toEqual({
      posted: 3,
      error: undefined,
    });
    const batch = first.posts[0] ?? [];
    expect(batch.map((e) => EventEnvelope.parse(e).sequence)).toEqual([
      1, 2, 3,
    ]);
    expect(batch.map((e) => EventEnvelope.parse(e).type)).toEqual([
      "task.status",
      "backlog.item",
      "pull_request",
    ]);

    const second = fakeFetch();
    expect((await runCycle(config, second.fetch, now)).posted).toBe(0);

    writeFileSync(
      join(fmHome, "state", "hero.status"),
      "working [at=1792167459]: started\ndone [at=1792167600]: PR ready\n",
    );
    const third = fakeFetch();
    await runCycle(config, third.fetch, now);
    expect(
      (third.posts[0] ?? []).map((e) => EventEnvelope.parse(e)),
    ).toMatchObject([
      { sequence: 4, state: "in_review", message: "done: PR ready" },
    ]);
  });

  it("keeps undelivered events for the next cycle when the Worker refuses them", async () => {
    const { config } = sandboxHome();
    const refused = fakeFetch(503);
    expect((await runCycle(config, refused.fetch, now)).error).toMatch(
      /event post failed: 503/,
    );
    const retry = fakeFetch();
    await runCycle(config, retry.fetch, now);
    expect(retry.posts[0]).toEqual(refused.posts[0]);
  });

  it("names missing run variables instead of posting", async () => {
    const { config } = sandboxHome();
    writeFileSync(join(config.stateDir, "env", "BRIDGE_TOKEN"), "");
    expect(await runCycle(config, fakeFetch().fetch, now)).toEqual({
      posted: 0,
      error: "missing BRIDGE_TOKEN",
    });
  });
});
