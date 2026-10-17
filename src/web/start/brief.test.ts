import { describe, expect, it } from "vitest";
import {
  addFiles,
  canSend,
  initialBrief,
  keepBrief,
  readBrief,
  starters,
} from "./brief";

const shot = new File(["x"], "home.png", { lastModified: 1 });
const other = new File(["yy"], "pricing.png", { lastModified: 2 });

describe("initialBrief", () => {
  it("starts empty with no starter", () => {
    expect(initialBrief(null, "")).toEqual({ text: "", files: [] });
  });

  it("pre-fills the starter draft from the query", () => {
    expect(initialBrief(null, "?starter=interaction").text).toBe(
      starters.interaction.draft,
    );
  });

  it("ignores unknown or inherited starter ids", () => {
    expect(initialBrief(null, "?starter=nope").text).toBe("");
    expect(initialBrief(null, "?starter=toString").text).toBe("");
    expect(initialBrief(null, "?starter=screenshots").text).toBe("");
  });

  it("restores the brief kept on the history entry over the starter", () => {
    const kept = keepBrief({ text: "my edit", files: [shot] });
    expect(initialBrief(kept, "?starter=daytona")).toEqual({
      text: "my edit",
      files: [shot],
    });
  });
});

describe("readBrief", () => {
  it("returns the kept brief, with its files", () => {
    const brief = { text: "copy this", files: [shot, other] };
    expect(readBrief(keepBrief(brief))).toBe(brief);
  });

  it("gives every kept brief its own id", () => {
    const a = keepBrief({ text: "a", files: [] });
    const b = keepBrief({ text: "b", files: [] });
    expect(a.draft).not.toBe(b.draft);
    expect(readBrief(a)?.text).toBe("a");
  });

  it("is null for the workspace's brief text", () => {
    const kept = keepBrief({ text: "a", files: [] });
    expect(readBrief({ brief: kept.draft })).toBeNull();
  });

  it("is null for state that refers to no kept brief", () => {
    expect(readBrief(null)).toBeNull();
    expect(readBrief({ draft: 1 })).toBeNull();
    expect(readBrief({ draft: "from-an-earlier-page-load" })).toBeNull();
    expect(readBrief({ draft: { text: "a", files: [] } })).toBeNull();
  });
});

describe("canSend", () => {
  it("is false while the text is empty or blank, even with attachments", () => {
    expect(canSend({ text: "", files: [] })).toBe(false);
    expect(canSend({ text: "  \n", files: [] })).toBe(false);
    expect(canSend({ text: "", files: [shot] })).toBe(false);
  });

  it("is true with text", () => {
    expect(canSend({ text: "copy this", files: [] })).toBe(true);
    expect(canSend({ text: "copy this", files: [shot] })).toBe(true);
  });
});

describe("addFiles", () => {
  it("keeps existing files and skips duplicates", () => {
    expect(addFiles([shot], [shot, other, other])).toEqual([shot, other]);
  });
});
