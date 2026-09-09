import { describe, expect, test } from "vitest";
import {
  getLocalSkill,
  LOCAL_REPAIR_GUIDANCE,
  LOCAL_REVIEW_GUIDANCE,
  LOCAL_SKILLS,
  systemPromptLocalRepair,
  systemPromptLocalReview,
} from "./index.js";

describe("local defensive skills", () => {
  test("gives the reviewer read-only guidance and the repairer the complete workflow", () => {
    expect(LOCAL_SKILLS.filter((skill) => skill.roles.includes("red")).map((skill) => skill.id))
      .toEqual(["evidence-review"]);
    expect(LOCAL_SKILLS.filter((skill) => skill.roles.includes("blue")).map((skill) => skill.id))
      .toEqual(["evidence-review", "minimal-repair", "regression-verification"]);
    expect(new Set(LOCAL_SKILLS.map((skill) => skill.id)).size).toBe(LOCAL_SKILLS.length);
    for (const skill of LOCAL_SKILLS) {
      expect(skill.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(skill.name.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.instructions.length).toBeGreaterThan(skill.description.length);
      expect(getLocalSkill(skill.id)).toBe(skill);
    }
    expect(getLocalSkill("unavailable-skill")).toBeUndefined();
  });

  test("keeps source edits and verification within the supplied test boundary", () => {
    expect(getLocalSkill("evidence-review")?.instructions).toContain("do not create payloads, tests, or patches");
    const repair = getLocalSkill("minimal-repair")!.instructions;
    expect(repair).toContain("Edit application source only");
    expect(repair).toContain("are protected");
    expect(repair).toContain("Do not weaken checks");
    const verification = getLocalSkill("regression-verification")!.instructions;
    expect(verification).toContain("run_regression and run_functional_tests");
    expect(verification).toContain("not proof that the repository has no security issues");
  });

  test.each([systemPromptLocalReview, systemPromptLocalRepair])("requires visible tool-backed plans without private deliberation", (prompt) => {
    const value = prompt();
    expect(value).toContain("use_skill({skillId,reason})");
    expect(value).toContain("report_progress({summary,nextAction,evidence,plan})");
    expect(value).toContain("Before repository tools, call use_skill and then report_progress");
    expect(value).toContain("repository-relative file paths");
    expect(value).toContain("at most one step may be in_progress");
    expect(value).toContain("not private internal deliberation or raw chain-of-thought");
    expect(value).toContain("mark completed only after observed work");
    expect(value).toContain("Include no secrets");
  });

  test("versions the changed prompts and advertises only each role's skills", () => {
    expect(LOCAL_REVIEW_GUIDANCE.version).toBe("1.1.0");
    expect(LOCAL_REPAIR_GUIDANCE.version).toBe("1.1.0");
    expect(systemPromptLocalReview()).toContain("Your available skill is evidence-review");
    expect(systemPromptLocalReview()).not.toContain("minimal-repair");
    expect(systemPromptLocalRepair()).toContain("evidence-review, minimal-repair, and regression-verification");
  });
});
