import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "@vouch/protocol";
import type { AgentTool } from "@vouch/model";
import type { LocalWorkspace } from "@vouch/sandbox";
import { buildLocalRepairTools, buildLocalReviewTools } from "./local-tools.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "vouch-trace-")); roots.push(dir);
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "app.py"), "def add(a, b): return a + b\n");
  writeFileSync(join(dir, "tests", "test_app.py"), "# supplied test\n");
  const workspace: LocalWorkspace = {
    dir, baselineDir: dir, verificationDir: join(dir, "verification"), commit: "a".repeat(40),
    regressionPath: "tests/test_app.py", regressionHash: "b".repeat(64), files: ["app.py", "tests/test_app.py"],
    protectedPaths: ["tests/test_app.py"], cleanup() {},
  };
  const events: EventInput[] = [];
  const controller = new AbortController();
  const tools = buildLocalReviewTools(workspace, controller.signal, event => events.push(event));
  let sequence = 0;
  const call = (name: string, args: unknown) => tools.find(tool => tool.name === name)!.execute(args, { callId: `call-${++sequence}` });
  return { events, controller, tools, call, workspace };
}
const plan = {
  summary: "The supplied test identifies the behavior to inspect.", nextAction: "Read the application source.", evidence: ["tests/test_app.py"],
  plan: [{ id: "inspect", title: "Inspect source", status: "in_progress" }],
};
const select = { skillId: "evidence-review", reason: "Locate the source checked by the supplied test." };

test("publishes actual role-scoped skill calls and public plans with the logged call identity", async () => {
  const f = fixture();
  expect(f.events).toEqual([]);
  await expect(f.call("read_file", { path: "app.py" })).rejects.toThrow("use_skill and report_progress");
  const skill = await f.call("use_skill", select) as { instructions: string };
  expect(skill.instructions).toContain("read-only");
  expect(f.events[0]).toMatchObject({ type: "skill_call", skillId: "evidence-review", callId: "call-2", agentRole: "red", stage: "REPRODUCE" });
  await expect(f.call("read_file", { path: "app.py" })).rejects.toThrow("report_progress");
  await f.call("report_progress", plan);
  expect(f.events[1]).toMatchObject({ type: "agent_update", ...plan, callId: "call-4" });
  await expect(f.call("read_file", { path: "app.py" })).resolves.toMatchObject({ content: expect.stringContaining("def add") });
  expect(f.tools.some(tool => tool.name === "write_file")).toBe(false);
});

test("rejects unknown skills, wrong roles and unobserved evidence without publishing a trace", async () => {
  const f = fixture();
  await expect(f.call("use_skill", { ...select, skillId: "unknown" })).rejects.toThrow("not available");
  await expect(f.call("use_skill", { ...select, skillId: "minimal-repair" })).rejects.toThrow("not available");
  await expect(f.call("report_progress", plan)).rejects.toThrow("use_skill");
  expect(f.events).toEqual([]);
  await f.call("use_skill", select);
  for (const path of ["app.py", "../outside.py", ".env", "missing.py"]) {
    await expect(f.call("report_progress", { ...plan, evidence: [path] })).rejects.toThrow("observed repository file");
  }
  expect(f.events).toHaveLength(1);
  await f.call("report_progress", { ...plan, evidence: [] });
  await f.call("grep", { pattern: "def add" });
  await expect(f.call("report_progress", { ...plan, evidence: ["app.py"] })).resolves.toMatchObject({ recorded: true });
});

test("keeps plans bounded and rejects duplicate IDs, multiple active steps and late calls", async () => {
  const f = fixture();
  await f.call("use_skill", select);
  await expect(f.call("report_progress", { ...plan, plan: [plan.plan[0], plan.plan[0]] })).rejects.toThrow("unique");
  await expect(f.call("report_progress", { ...plan, plan: [plan.plan[0], { ...plan.plan[0], id: "other" }] })).rejects.toThrow("only one");
  await expect(f.call("report_progress", { ...plan, summary: "x".repeat(501) })).rejects.toThrow();
  await expect(f.call("report_progress", { ...plan, summary: "line\nline" })).rejects.toThrow();
  expect(f.events).toHaveLength(1);
  f.controller.abort();
  await expect(f.call("report_progress", plan)).rejects.toThrow();
  expect(f.events).toHaveLength(1);
});

test("serializes model tool batches so a plan can precede reads in the same response", async () => {
  const f = fixture();
  await expect(Promise.all([
    f.call("use_skill", select), f.call("report_progress", plan), f.call("read_file", { path: "app.py" }),
  ])).resolves.toHaveLength(3);
  expect(f.events.map(event => event.type)).toEqual(["skill_call", "agent_update"]);
  const unlogged = f.tools.find(tool => tool.name === "use_skill") as AgentTool;
  await expect(unlogged.execute(select)).rejects.toThrow("logged call context");
});

test("normalizes successful observations and accepts newly created application source as evidence", async () => {
  const f = fixture();
  await f.call("use_skill", select);
  await f.call("report_progress", plan);
  await f.call("read_file", { path: "./app.py" });
  await f.call("report_progress", { ...plan, evidence: ["app.py"] });
  const repair = buildLocalRepairTools({
    workspace: f.workspace, signal: f.controller.signal, onEvent: event => f.events.push(event),
    remainingTimeoutMs: () => 1000, onTestResult: () => undefined,
    runner: { prepare: async () => {}, cleanup: async () => {}, runTests: async () => { throw new Error("unused"); } },
  });
  const call = (name: string, args: unknown) => repair.tools.find(tool => tool.name === name)!.execute(args, { callId: name });
  await call("use_skill", { ...select, skillId: "minimal-repair" });
  await call("report_progress", plan);
  await call("write_file", { path: "new.py", content: "def identity(value): return value\n" });
  await expect(call("report_progress", { ...plan, evidence: ["./new.py"] })).resolves.toMatchObject({ recorded: true });
  expect(f.events.at(-1)).toMatchObject({ type: "agent_update", evidence: ["new.py"] });
});
