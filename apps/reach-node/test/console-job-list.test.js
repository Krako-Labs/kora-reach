import { describe, expect, it } from "vitest";
import { navigationIndex } from "../src/console/job-list.js";

describe("job list focus navigation", () => {
  it("moves to adjacent jobs without wrapping", () => {
    expect(navigationIndex("ArrowDown", 0, 3)).toBe(1);
    expect(navigationIndex("ArrowUp", 2, 3)).toBe(1);
    expect(navigationIndex("ArrowUp", 0, 3)).toBe(0);
    expect(navigationIndex("ArrowDown", 2, 3)).toBe(2);
  });
  it("moves to first and last visible jobs", () => {
    expect(navigationIndex("Home", 1, 3)).toBe(0);
    expect(navigationIndex("End", 1, 3)).toBe(2);
  });
  it("leaves native activation and tab traversal alone", () => {
    for (const key of ["Enter", " ", "Tab", "Escape", "ArrowLeft", "ArrowRight", "a"])
      expect(navigationIndex(key, 1, 3)).toBeNull();
  });
  it("leaves modified and composing keys alone", () => {
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End"])
      expect(navigationIndex(key, 1, 3, true)).toBeNull();
  });
  it("ignores empty lists and events outside job buttons", () => {
    expect(navigationIndex("End", -1, 0)).toBeNull();
    expect(navigationIndex("ArrowDown", -1, 3)).toBeNull();
    expect(navigationIndex("ArrowUp", 3, 3)).toBeNull();
  });
  it("keeps a single job focused", () => {
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End"])
      expect(navigationIndex(key, 0, 1)).toBe(0);
  });
});
