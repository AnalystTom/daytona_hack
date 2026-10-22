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

  it("requires an explicitly scoped query without weakening origin or path checks", () => {
    const queried = { ...scope, paths: ["/search?q=robots&next=a?b"] };
    expect(
      inScope("https://example.com/search/?q=robots&next=a?b", queried),
    ).toBe(true);
    for (const url of [
      "https://example.com/search",
      "https://example.com/search?q=agents&next=a?b",
      "https://example.com/search?q=robots&next=a?b&extra=1",
      "https://example.com/other?q=robots&next=a?b",
      "https://evil.test/search?q=robots&next=a?b",
    ])
      expect(inScope(url, queried)).toBe(false);
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

  it("accepts at most 10 paths", () => {
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `/p${i}`);
    expect(CaptureScope.safeParse({ ...scope, paths: paths(10) }).success).toBe(
      true,
    );
    expect(CaptureScope.safeParse({ ...scope, paths: paths(11) }).success).toBe(
      false,
    );
  });

  it("accepts query-bearing paths while refusing fragments and relative targets", () => {
    expect(
      CaptureScope.safeParse({ ...scope, paths: ["/search?q=robots"] }).success,
    ).toBe(true);
    expect(
      CaptureScope.safeParse({ ...scope, paths: ["/search?q=robots#details"] })
        .success,
    ).toBe(false);
    expect(
      CaptureScope.safeParse({ ...scope, paths: ["search?q=robots"] }).success,
    ).toBe(false);
  });
});
