import { expect, it } from "vitest";
import { posix } from "node:path";
import { safeJoin } from "./src/join";

it("resolved path stays inside root", () => {
  const root = "/var/app";
  let result: string;
  try {
    result = safeJoin(root, "..", "etc", "passwd");
  } catch {
    return;
  }
  const resolved = posix.normalize(result);
  expect(resolved === root || resolved.startsWith(`${root}/`)).toBe(true);
});
