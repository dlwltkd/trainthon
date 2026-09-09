import { describe, expect, it } from "vitest";
import { safeJoin } from "./join";

describe("safeJoin", () => {
  it("joins ordinary segments under the root", () => {
    expect(safeJoin("/var/app", "uploads", "a.txt")).toBe("/var/app/uploads/a.txt");
  });

  it("joins a single segment", () => {
    expect(safeJoin("/data", "file")).toBe("/data/file");
  });
});
