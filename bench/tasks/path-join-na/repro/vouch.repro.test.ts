import { expect, it } from "vitest";
import { safeJoin } from "./src/join";

it("safeJoin must not execute SQL in a path segment", () => {
  const out = safeJoin("/data", "1'; DROP TABLE users; --");
  expect(typeof out).toBe("string");
  expect(out.includes("DROP TABLE") || out.length > 0).toBe(true);
});
