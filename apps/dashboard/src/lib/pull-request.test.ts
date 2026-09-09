import { describe, expect, it } from "vitest";
import { canDeliverPatch, pullRequestLink } from "./pull-request";

const repository = "https://github.com/example/repository";

describe("draft delivery eligibility", () => {
  it("only enables delivery for a public repository with a completed source patch", () => {
    expect(canDeliverPatch("PATCH_PROPOSED", repository, 1)).toBe(true);
    expect(canDeliverPatch("TESTS_PASSED", repository, 1)).toBe(true);
    expect(canDeliverPatch("PATCH_PROPOSED", repository, 0)).toBe(false);
    expect(canDeliverPatch("PATCH_PROPOSED", "/tmp/repository", 1)).toBe(false);
    expect(canDeliverPatch("REVIEW_COMPLETE", repository, 1)).toBe(false);
    expect(canDeliverPatch("RUNNING", repository, 1)).toBe(false);
    expect(canDeliverPatch("FAILED_NO_FIX", repository, 1)).toBe(false);
  });

  it("only accepts a returned PR link in the same canonical GitHub repository", () => {
    expect(pullRequestLink(`${repository}/pull/12`, repository)).toBe(`${repository}/pull/12`);
    expect(pullRequestLink("javascript:alert(1)", repository)).toBeNull();
    expect(pullRequestLink(`${repository}/pull/12?redirect=elsewhere`, repository)).toBeNull();
    expect(pullRequestLink("https://github.com/other/repository/pull/12", repository)).toBeNull();
    expect(pullRequestLink("https://github.com.attacker.test/example/repository/pull/12", repository)).toBeNull();
  });
});
