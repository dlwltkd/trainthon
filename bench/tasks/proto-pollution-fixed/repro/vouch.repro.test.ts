// Dev artifact for keyless smoke-tests only: what a scripted Red role submits.
// Deliberately narrower than the hidden grader oracle (one vector, not two).
import { expect, it } from "vitest";
import { deepMerge } from "./src/merge";

it("deepMerge must not let __proto__ reach Object.prototype", () => {
  deepMerge({}, JSON.parse('{"__proto__": {"vouchPolluted": true}}'));
  expect(({} as Record<string, unknown>)["vouchPolluted"]).toBeUndefined();
});
