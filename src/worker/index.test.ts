import { describe, expect, it } from "vitest";
import { version } from "../../package.json";
import worker from "./index";

const call = (path: string) =>
  worker.fetch(new Request(`https://reversy.test${path}`));

describe("worker", () => {
  it("reports health with the package version", async () => {
    const response = await call("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version });
  });

  it("returns 404 for unknown API routes", async () => {
    expect((await call("/api/nope")).status).toBe(404);
  });
});
