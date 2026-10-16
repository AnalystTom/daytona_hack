import { describe, expect, it } from "vitest";
import { CaptureScope, inScope } from "./evidence";

const scope = { origin: "https://example.com", paths: ["/", "/pricing"] };

describe("inScope", () => {
  it("accepts approved paths on the approved origin, ignoring a trailing slash and query", () => {
    expect(inScope("https://example.com/", scope)).toBe(true);
    expect(inScope("https://example.com/pricing/?plan=pro", scope)).toBe(true);
  });

  it("rejects other origins, unapproved paths and junk", () => {
    expect(inScope("https://evil.test/pricing", scope)).toBe(false);
    expect(inScope("http://example.com/pricing", scope)).toBe(false);
    expect(inScope("https://example.com/login", scope)).toBe(false);
    expect(inScope("not a url", scope)).toBe(false);
  });
});

describe("CaptureScope", () => {
  it("requires a bare http(s) origin and absolute paths", () => {
    expect(CaptureScope.safeParse(scope).success).toBe(true);
    expect(
      CaptureScope.safeParse({ ...scope, origin: "https://example.com/" })
        .success,
    ).toBe(false);
    expect(
      CaptureScope.safeParse({ ...scope, origin: "file:///etc" }).success,
    ).toBe(false);
    expect(
      CaptureScope.safeParse({ ...scope, paths: ["pricing"] }).success,
    ).toBe(false);
  });
});
