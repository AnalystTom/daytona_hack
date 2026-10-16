import { describe, expect, it } from "vitest";
import { SurrealRunStore } from "./surreal";
import { StoreError } from "./types";

const config = {
  url: "https://db.example.com/",
  namespace: "reversy",
  database: "runs",
  user: "worker",
  password: "secret",
};

const storeAnswering = (answer: () => Response | Promise<Response>) => {
  const requests: Request[] = [];
  const store = new SurrealRunStore(config, async (input, init) => {
    requests.push(new Request(input, init));
    return answer();
  });
  return { store, requests };
};

describe("SurrealRunStore over HTTP", () => {
  it("sends authenticated RPC queries to the configured namespace and database", async () => {
    const { store, requests } = storeAnswering(() =>
      Response.json({ id: 1, result: [{ status: "OK", result: null }] }),
    );
    expect(await store.getRun("r1")).toBeNull();
    const request = requests.at(-1) as Request;
    expect(request.url).toBe("https://db.example.com/rpc");
    expect(request.headers.get("surreal-ns")).toBe("reversy");
    expect(request.headers.get("surreal-db")).toBe("runs");
    expect(request.headers.get("authorization")).toBe(
      `Basic ${btoa("worker:secret")}`,
    );
    const body = (await request.json()) as {
      method: string;
      params: unknown[];
    };
    expect(body.method).toBe("query");
    expect(body.params[1]).toEqual({ runId: "r1" });
  });

  it.each([
    ["an HTTP error", () => new Response("nope", { status: 502 })],
    [
      "an RPC error",
      () => Response.json({ id: 1, error: { message: "bad auth" } }),
    ],
    [
      "a failed statement",
      () => Response.json({ id: 1, result: [{ status: "ERR", result: "x" }] }),
    ],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
  ])("reports %s as a StoreError", async (_name, answer) => {
    const { store } = storeAnswering(answer);
    await expect(store.getRun("r1")).rejects.toBeInstanceOf(StoreError);
  });
});
