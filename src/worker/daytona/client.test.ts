import { describe, expect, it, vi } from "vitest";
import { createDaytonaClient, DaytonaError } from "./client";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function setup(responses: Response[]) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  });
  const client = createDaytonaClient({
    apiKey: "key",
    apiUrl: "https://daytona.test/api",
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  const request = (n: number) => {
    const [url, init] = fetch.mock.calls[n] ?? [];
    return {
      url,
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
  };
  return { client, request };
}

describe("Daytona client", () => {
  it("creates a sandbox from a snapshot with the API key", async () => {
    const { client, request } = setup([json({ id: "sb1", labels: {} })]);
    await client.create({ snapshot: "reversy-run", labels: { a: "b" } });
    expect(request(0)).toMatchObject({
      url: "https://daytona.test/api/sandbox",
      method: "POST",
      headers: { Authorization: "Bearer key" },
      body: { snapshot: "reversy-run", labels: { a: "b" } },
    });
  });

  it("filters the list by JSON-encoded labels", async () => {
    const { client, request } = setup([
      json({ items: [{ id: "sb1" }], nextCursor: null }),
    ]);
    expect(await client.list({ "reversy.run": "r1" })).toEqual([{ id: "sb1" }]);
    expect(request(0).url).toBe(
      `https://daytona.test/api/sandbox?limit=100&labels=${encodeURIComponent('{"reversy.run":"r1"}')}`,
    );
  });

  it("runs commands through the sandbox's toolbox proxy and caches it", async () => {
    const { client, request } = setup([
      json({ url: "https://proxy.daytona.test/toolbox/" }),
      json({ exitCode: 0, result: "hi" }),
      json({ result: "again" }),
    ]);
    expect(await client.exec("sb1", "echo hi", { envs: { A: "1" } })).toEqual({
      exitCode: 0,
      result: "hi",
    });
    expect(request(0).url).toBe(
      "https://daytona.test/api/sandbox/sb1/toolbox-proxy-url",
    );
    expect(request(1)).toMatchObject({
      url: "https://proxy.daytona.test/toolbox/sb1/process/execute",
      body: { command: "echo hi", envs: { A: "1" }, timeout: 60 },
    });
    expect(await client.exec("sb1", "echo again")).toEqual({
      exitCode: 0,
      result: "again",
    });
    expect(request(2).url).toBe(
      "https://proxy.daytona.test/toolbox/sb1/process/execute",
    );
  });

  it("starts a background session command", async () => {
    const { client, request } = setup([
      json({ url: "https://proxy.daytona.test/toolbox" }),
      json({}),
      json({ cmdId: "c1" }),
    ]);
    expect(await client.startSessionCommand("sb1", "boot", "./boot.sh")).toBe(
      "c1",
    );
    expect(request(1)).toMatchObject({
      url: "https://proxy.daytona.test/toolbox/sb1/process/session",
      body: { sessionId: "boot" },
    });
    expect(request(2)).toMatchObject({
      url: "https://proxy.daytona.test/toolbox/sb1/process/session/boot/exec",
      body: { command: "./boot.sh", runAsync: true },
    });
  });

  it("gets a signed preview link, forks, snapshots, stops and deletes", async () => {
    const { client, request } = setup([
      json({ url: "https://4173-sb1.preview.test?tkn=x", token: "x" }),
      json({ id: "sb2", labels: {} }),
      json({ id: "sb1", labels: {}, state: "snapshotting" }),
      json({ id: "sb1", labels: {} }),
      json({ id: "sb1", labels: {} }),
    ]);
    expect((await client.previewLink("sb1", 4173, 3600)).url).toContain(
      "4173-sb1",
    );
    await client.fork("sb1");
    await client.snapshot("sb1", "copy-1");
    await client.stop("sb1");
    await client.remove("sb1");
    expect(request(0).url).toBe(
      "https://daytona.test/api/sandbox/sb1/ports/4173/signed-preview-url?expiresInSeconds=3600",
    );
    expect(request(1)).toMatchObject({
      url: "https://daytona.test/api/sandbox/sb1/fork",
      method: "POST",
    });
    expect(request(2)).toMatchObject({
      url: "https://daytona.test/api/sandbox/sb1/snapshot",
      body: { name: "copy-1" },
    });
    expect(request(3).url).toBe("https://daytona.test/api/sandbox/sb1/stop");
    expect(request(4)).toMatchObject({
      url: "https://daytona.test/api/sandbox/sb1",
      method: "DELETE",
    });
  });

  it("deletes a snapshot by resolving its name to an id", async () => {
    const { client, request } = setup([json({ id: "snap-9" }), json({})]);
    await client.removeSnapshot("copy-1");
    expect(request(0).url).toBe("https://daytona.test/api/snapshots/copy-1");
    expect(request(1)).toMatchObject({
      url: "https://daytona.test/api/snapshots/snap-9",
      method: "DELETE",
    });
  });

  it("raises a DaytonaError carrying the HTTP status", async () => {
    const { client } = setup([
      new Response("fork not supported", { status: 400 }),
    ]);
    const error = await client.fork("sb1").catch((e) => e);
    expect(error).toBeInstanceOf(DaytonaError);
    expect(error.status).toBe(400);
    expect(error.message).toContain("fork not supported");
  });
});
