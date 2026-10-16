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
    expect(a.brief).not.toBe(b.brief);
    expect(readBrief(a)?.text).toBe("a");
  });

  it("is null for state that refers to no kept brief", () => {
    expect(readBrief(null)).toBeNull();
    expect(readBrief({ brief: 1 })).toBeNull();
    expect(readBrief({ brief: "from-an-earlier-page-load" })).toBeNull();
    expect(readBrief({ brief: { text: "a", files: [] } })).toBeNull();
  });
});

describe("canSend", () => {
  it("is false while the brief is empty or blank", () => {
    expect(canSend({ text: "", files: [] })).toBe(false);
    expect(canSend({ text: "  \n", files: [] })).toBe(false);
  });

  it("is true with text or an attachment", () => {
    expect(canSend({ text: "copy this", files: [] })).toBe(true);
    expect(canSend({ text: "", files: [shot] })).toBe(true);
  });
});

describe("addFiles", () => {
  it("keeps existing files and skips duplicates", () => {
    expect(addFiles([shot], [shot, other, other])).toEqual([shot, other]);
  });
});
