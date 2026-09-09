import { describe, expect, it } from "vitest";
import { deepMerge } from "./merge";

describe("deepMerge", () => {
  it("merges nested objects", () => {
    expect(deepMerge({ a: { x: 1 } }, { a: { y: 2 }, b: 3 })).toEqual({
      a: { x: 1, y: 2 },
      b: 3,
    });
  });

  it("overwrites primitive values", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });
});
