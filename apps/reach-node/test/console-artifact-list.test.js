import { describe, expect, it } from "vitest";
import { artifactNavigationIndex, formatBytes } from "../src/console/artifact-list.js";

describe("artifact list focus navigation", () => {
  it("moves to adjacent artifacts without wrapping", () => {
    expect(artifactNavigationIndex("ArrowDown", 0, 3)).toBe(1);
    expect(artifactNavigationIndex("ArrowUp", 2, 3)).toBe(1);
    expect(artifactNavigationIndex("ArrowUp", 0, 3)).toBe(0);
    expect(artifactNavigationIndex("ArrowDown", 2, 3)).toBe(2);
  });

  it("moves to the first and last visible artifacts", () => {
    expect(artifactNavigationIndex("Home", 1, 3)).toBe(0);
    expect(artifactNavigationIndex("End", 1, 3)).toBe(2);
  });

  it("leaves native activation and tab traversal alone", () => {
    for (const key of ["Enter", " ", "Tab", "Escape", "ArrowLeft", "ArrowRight", "a"])
      expect(artifactNavigationIndex(key, 1, 3)).toBeNull();
  });

  it("leaves modified and composing keys alone", () => {
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End"])
      expect(artifactNavigationIndex(key, 1, 3, true)).toBeNull();
  });

  it("ignores empty lists, outside events and keeps one artifact focused", () => {
    expect(artifactNavigationIndex("End", -1, 0)).toBeNull();
    expect(artifactNavigationIndex("ArrowDown", -1, 3)).toBeNull();
    expect(artifactNavigationIndex("ArrowUp", 3, 3)).toBeNull();
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End"])
      expect(artifactNavigationIndex(key, 0, 1)).toBe(0);
  });

  it("formats bounded list metadata consistently", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
