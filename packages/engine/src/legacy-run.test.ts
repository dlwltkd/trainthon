import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessEvent, RunConfig, Task } from "@vouch/protocol";
import { executeRun } from "./run.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(fixed = false) {
  const root = mkdtempSync(join(tmpdir(), "vouch-legacy-benign-"));
  temporary.push(root);
  const benchDir = join(root, "bench");
  const id = fixed ? "arithmetic-control" : "arithmetic-regression";
  const taskDir = join(benchDir, "tasks", id);
  const project = join(taskDir, "repo");
  function put(path: string, content: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  put(join(project, "package.json"), '{"type":"module"}');
  put(join(project, "vitest.config.ts"), 'export default { test: { include: ["**/*.test.ts"] } };');
  put(join(project, "src/math.ts"), `export const twice = (n: number) => n * 2${fixed ? "" : " + 1"};`);
  put(join(project, "src/math.test.ts"), 'import { expect, test } from "vitest"; import { twice } from "./math"; test("returns a number", () => expect(typeof twice(2)).toBe("number"));');
  const regression = 'import { expect, test } from "vitest"; import { twice } from "./src/math"; test("doubles its input", () => expect(twice(2)).toBe(4));';
  put(join(taskDir, "repro/vouch.repro.test.ts"), regression);
  put(join(taskDir, "solution/src/math.ts"), 'export const twice = (n: number) => n * 2;');
  put(join(benchDir, "graders", id, "oracle.test.ts"), regression);
  put(join(benchDir, "graders", id, "grader.json"), JSON.stringify({
    exploitFile: "oracle.test.ts", exploitDest: "oracle.test.ts", exploitCmd: "vitest run oracle.test.ts",
    functionalCmd: "vitest run src/math.test.ts", guardedPaths: ["src/math.ts"],
  }));
  const task: Task = {
    id, group: "arithmetic", kind: fixed ? "control_fixed" : "vuln", source: "synthetic", split: "dev",
    repoRef: { url: project, commit: "HEAD" }, report: { text: "twice adds one unexpectedly", hintLevel: 3 },
    publicTests: ["src/math.test.ts"], testCmd: "vitest run src/math.test.ts",
  };
  const config: RunConfig = {
    condition: "C", mode: "scripted", model: "scripted", seed: 1, graderVersion: "test",
    budgets: { maxSteps: 4, maxTokens: 100, maxWallMs: 30_000 },
  };
  return { task, config, repoRoot, benchDir, runsDir: join(root, "runs") };
}

describe("legacy benign fixture integration", () => {
  it("validates a supplied regression, repairs source, and streams persisted events", async () => {
    const options = fixture();
    const observed: HarnessEvent[] = [];
    const record = await executeRun({ ...options, onEvent: (event) => observed.push(event) });
    expect(record.status, JSON.stringify(record.events)).toBe("FIXED_VERIFIED");
    expect(record.events).toEqual(observed);
    expect(record.events).toContainEqual(expect.objectContaining({ type: "gate", phase: "verify", passed: true }));
    expect(existsSync(join(options.runsDir, `${record.runId}.jsonl`))).toBe(true);
    expect(existsSync(join(repoRoot, ".worktrees", record.runId))).toBe(false);
  }, 40_000);

  it("leaves an already-passing control unchanged", async () => {
    const record = await executeRun(fixture(true));
    expect(record.status).toBe("NOT_REPRODUCIBLE");
    expect(record.metrics?.diffLineCount).toBe(0);
  }, 40_000);

  it("shares the step budget between regression validation and repair", async () => {
    const options = fixture();
    options.config.budgets.maxSteps = 1;
    const record = await executeRun(options);
    expect(record.status).toBe("BUDGET_TIMEOUT");
    expect(record.events.filter((event) => event.type === "budget_update").at(-1)).toMatchObject({ steps: 1 });
  }, 40_000);
});
