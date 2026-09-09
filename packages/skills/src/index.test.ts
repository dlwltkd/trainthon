import { describe, expect, test } from "vitest";
import {
  getLocalSkill,
  LOCAL_REPAIR_GUIDANCE,
  LOCAL_REVIEW_GUIDANCE,
  LOCAL_SKILLS,
  REPOSITORY_REVIEW_GUIDANCE,
  REPOSITORY_REVIEW_SKILLS,
  SOURCE_REPAIR_GUIDANCE,
  SOURCE_REPAIR_SKILLS,
  systemPromptLocalRepair,
  systemPromptLocalReview,
  systemPromptRepositoryRepair,
  systemPromptRepositoryReview,
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

describe("source review and remediation skills", () => {
  test("shares contract review across roles without including development answers or runtime privileges", () => {
    const review = REPOSITORY_REVIEW_SKILLS.find(skill => skill.id === "security-contract-review")!;
    expect(SOURCE_REPAIR_SKILLS.find(skill => skill.id === review.id)).toBe(review);
    expect(review.instructions).toContain("initialization before a try block");
    expect(review.instructions).toContain("leave the source unchanged");
    expect(review.instructions).toContain("original source verdict distinct");
    expect(review.instructions).toContain("do not modify files");
    for (const skill of SOURCE_REPAIR_SKILLS) expect(skill.instructions).not.toMatch(/development20|case-\d{2}|CVE-\d{4}-\d+|referenceSha256/);
  });

  test("separates review specializations from source-edit capabilities", () => {
    expect(REPOSITORY_REVIEW_SKILLS.map(skill => skill.id)).toEqual([
      "source-security-review", "security-contract-review", "auth-boundary-review", "config-dependency-review", "remediation-planning",
    ]);
    expect(SOURCE_REPAIR_SKILLS.map(skill => skill.id)).toEqual([
      "source-security-review", "security-contract-review", "source-remediation", "change-validation",
    ]);
    expect(SOURCE_REPAIR_SKILLS[0]).toBe(REPOSITORY_REVIEW_SKILLS[0]);
    for (const catalog of [REPOSITORY_REVIEW_SKILLS, SOURCE_REPAIR_SKILLS]) {
      expect(new Set(catalog.map(skill => skill.id)).size).toBe(catalog.length);
      for (const skill of catalog) {
        expect(skill.roles).toEqual(["source-remediation", "change-validation"].includes(skill.id) ? ["blue"] : ["red", "blue"]);
        expect(skill.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(skill.instructions.length).toBeGreaterThan(skill.description.length);
      }
    }
    expect(LOCAL_SKILLS.map(skill => skill.id)).not.toContain("source-remediation");
  });

  test("requires source observations and accounts for missing deployment or advisory evidence", () => {
    const auth = REPOSITORY_REVIEW_SKILLS.find(skill => skill.id === "auth-boundary-review")!.instructions;
    expect(auth).toContain("checks inherited from routers or shared helpers");
    expect(auth).toContain("unread middleware and deployment assumptions as uncertainty");
    const dependencies = REPOSITORY_REVIEW_SKILLS.find(skill => skill.id === "config-dependency-review")!.instructions;
    expect(dependencies).toContain("version alone is not proof of a vulnerability");
    expect(dependencies).toContain("Never print credential values");
    expect(dependencies).toContain("Do not install dependencies, fetch advisories");
    const planning = REPOSITORY_REVIEW_SKILLS.find(skill => skill.id === "remediation-planning")!.instructions;
    expect(planning).toContain("without creating test code or claiming any check was executed");
  });

  test.each([systemPromptRepositoryReview, systemPromptRepositoryRepair])("requires real findings and bounded public progress", (prompt) => {
    const value = prompt();
    expect(value).toContain("report_finding({id,title,severity,confidence,evidence,summary,recommendation})");
    expect(value).toContain("severity must be low, medium, high, critical, or info");
    expect(value).toContain("confidence must be confirmed or potential");
    expect(value).toContain("only repository-relative paths observed through successful repository tools");
    expect(value).toContain("include progress: {summary,nextAction,evidence,plan} in the initial use_skill call");
    expect(value).toContain("Use at most six plan steps");
    expect(value).toContain("not private internal deliberation or raw chain-of-thought");
    expect(value).toContain("Before finishing, call report_progress");
    expect(value).toContain("do not invent a finding");
  });

  test("binds source writes to recorded findings and final diff inspection without assumed tests", () => {
    const repair = systemPromptRepositoryRepair();
    expect(repair).toContain("write_file only while source-remediation is active and a confirmed finding has been recorded");
    expect(repair).toContain("No shell, code execution, test execution, or network tools are available");
    expect(repair).toContain("Existing tests, configuration, manifests, lockfiles, setup files, and hidden files are protected");
    expect(repair).toContain("After the final edit, load change-validation and call inspect_diff");
    const validation = SOURCE_REPAIR_SKILLS.find(skill => skill.id === "change-validation")!.instructions;
    expect(validation).toContain("testsRun:false means no tests ran");
    expect(validation).toContain("An earlier diff does not validate a later edit");
    expect(validation).toContain("do not edit files");
    expect(systemPromptRepositoryReview()).toContain("result scope is source_review");
    expect(systemPromptRepositoryReview()).not.toContain("source-remediation");
    expect(REPOSITORY_REVIEW_GUIDANCE.version).toBe("1.4.0");
    expect(SOURCE_REPAIR_GUIDANCE.version).toBe("1.3.0");
  });

  test("separates Red's read-only discovery from Blue's independent source validation", () => {
    expect(systemPromptRepositoryReview("red")).toContain("You are Red, the source reviewer");
    expect(systemPromptRepositoryReview("red")).toContain("Complete the relevant source investigation before returning your final handoff");
    expect(systemPromptRepositoryReview("red")).not.toContain("early final handoff");
    expect(systemPromptRepositoryReview()).toContain("supported, rejected, or unresolved");
    expect(systemPromptRepositoryRepair()).toContain("Record your own supported finding before editing");
    expect(systemPromptRepositoryRepair()).toContain("bounded read_file line ranges");
  });
});
