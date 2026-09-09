import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentTool } from "@vouch/model";
import type { LocalWorkspace } from "@vouch/sandbox";
import type { EventInput } from "@vouch/protocol";
import { buildLocalRepairTools, buildSourceReviewTools } from "./local-tools.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const plan = { summary: "Inspect source evidence.", nextAction: "Read the relevant source page.", evidence: [], plan: [{ id: "inspect", title: "Inspect source", status: "in_progress" }] };
type ReadPage = { content: string; truncated: boolean; next: { startLine: number; startColumn: number } | null };
type SearchPage = { hits: { line: number }[]; truncated: boolean; nextOffset: number | null };
type DirectoryPage = { entries: string[]; truncated: boolean; nextOffset: number | null };

async function fixture(files: Record<string, string>, remediate = false) {
  const dir = mkdtempSync(join(tmpdir(), "vouch-source-pages-")); roots.push(dir);
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
  const workspace: LocalWorkspace = { dir, baselineDir: dir, verificationDir: join(dir, "verification"), commit: "a".repeat(40), regressionPath: "tests/test_app.py", regressionHash: "b".repeat(64), files: Object.keys(files), protectedPaths: Object.keys(files).filter(path => path.startsWith("tests/")), cleanup() {} };
  const controller = new AbortController();
  const toolset = buildSourceReviewTools(workspace, controller.signal, () => {}, remediate);
  const call = caller(toolset.tools);
  await call("use_skill", { skillId: "source-security-review", reason: "Inspect source evidence." });
  await call("report_progress", plan);
  return { dir, workspace, controller, call, toolset };
}

function caller(tools: AgentTool[]) {
  let sequence = 0;
  return async <T = unknown>(name: string, args: unknown): Promise<T> => {
    const tool = tools.find(tool => tool.name === name)!;
    return await tool.execute(tool.schema.parse(args), { callId: `call-${++sequence}` }) as T;
  };
}

test("read_file bounds serialized bytes and resumes every character of large Unicode and minified lines", async () => {
  const source = "header\n" + "가😀\"\\\t".repeat(14_000) + "TAIL_AFTER_100K\nlast line\n";
  const f = await fixture({ "app.py": source });
  let cursor = { startLine: 1, startColumn: 0 };
  let reconstructed = "";
  let count = 0;
  do {
    const page = await f.call<ReadPage>("read_file", { path: "app.py", ...cursor });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(12_300);
    expect(page.content).not.toContain("... [truncated]");
    reconstructed += page.content;
    count++;
    if (!page.truncated) { expect(page.next).toBeNull(); break; }
    expect(page.next).not.toEqual(cursor);
    cursor = page.next!;
  } while (count < 100);
  expect(count).toBeGreaterThan(10);
  expect(reconstructed).toBe(source);
});

test("read_file line ranges preserve boundaries and validate cursors", async () => {
  const f = await fixture({ "app.py": "one\ntwo\nthree\n", "empty.py": "" });
  expect(await f.call("read_file", { path: "app.py", maxLines: 2 })).toMatchObject({ content: "one\ntwo\n", totalLines: 4, truncated: true, next: { startLine: 3, startColumn: 0 } });
  expect(await f.call("read_file", { path: "app.py", startLine: 3, startColumn: 2 })).toMatchObject({ content: "ree\n", truncated: false, next: null });
  expect(await f.call("read_file", { path: "empty.py" })).toMatchObject({ content: "", truncated: false, totalLines: 1 });
  await expect(f.call("read_file", { path: "app.py", startLine: 9 })).rejects.toThrow("outside the file");
  await expect(f.call("read_file", { path: "app.py", startColumn: 9 })).rejects.toThrow("outside the file");
});

test("grep caps pages, preserves matching-line offsets and scopes searches", async () => {
  const source = Array.from({ length: 90 }, (_, index) => `rate ${index}: ${"가".repeat(500)}`).join("\n");
  const f = await fixture({ "src/app.py": source, "other.py": "rate elsewhere", "src/large.py": "x".repeat(150_000) + "rate-tail" });
  let offset = 0;
  const lines: number[] = [];
  for (;;) {
    const page = await f.call<SearchPage>("grep", { pattern: "rate", path: "src/app.py", offset });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(8_300);
    lines.push(...page.hits.map((hit: { line: number }) => hit.line));
    if (!page.truncated) { expect(page.nextOffset).toBeNull(); break; }
    expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset!;
  }
  expect(lines).toEqual(Array.from({ length: 90 }, (_, index) => index + 1));
  const tail = await f.call<SearchPage>("grep", { pattern: "rate-tail", path: "src/large.py" });
  expect(tail.hits).toEqual([expect.objectContaining({ file: "src/large.py", line: 1, column: 149_920, text: expect.stringContaining("rate-tail"), textTruncated: true })]);
  const exact = await f.call<SearchPage>("grep", { pattern: "rate", path: "src/app.py", limit: 2 });
  expect(exact.hits).toHaveLength(2); expect(exact.nextOffset).toBe(2);
});

test("grep explains empty regex-looking queries while preserving actual literal matches and evidence", async () => {
  const f = await fixture({ "app.py": "rate_limit = 429\n", "literal.py": "literal text: left|right\n" });
  const empty = await f.call("grep", { pattern: "rate_limit|429|throttle" });
  expect(empty).toEqual({ pattern: "rate_limit|429|throttle", searchMode: "literal", hits: [], truncated: false, nextOffset: null, warning: "Literal search: regex operators are not expanded; use separate exact substring queries." });
  await expect(f.call("report_progress", { ...plan, evidence: ["app.py"] })).rejects.toThrow("observed repository file");
  const literal = await f.call("grep", { pattern: "left|right" });
  expect(literal).toMatchObject({ pattern: "left|right", searchMode: "literal", hits: [expect.objectContaining({ file: "literal.py" })], truncated: false });
  expect(literal).not.toHaveProperty("warning");
  await f.call("report_progress", { ...plan, evidence: ["literal.py"] });
  expect(await f.call("grep", { pattern: "missing_plain_text" })).not.toHaveProperty("warning");
});

test("directory pages bound long path inventories without dropping entries", async () => {
  const paths = Array.from({ length: 90 }, (_, index) => `${index.toString().padStart(3, "0")}_${"x".repeat(200)}.py`);
  const f = await fixture(Object.fromEntries(paths.map(path => [path, ""])));
  const collected: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await f.call<DirectoryPage>("list_dir", { offset });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(8_300);
    collected.push(...page.entries);
    if (!page.truncated) break;
    expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset!;
  }
  expect(collected).toEqual(paths);
});

test("only returned search evidence is observed, listings paginate without granting evidence", async () => {
  const f = await fixture({ "a.py": "rate", "b.py": "rate", "c.py": "rate" });
  expect(await f.call("list_dir", { limit: 2 })).toEqual({ entries: ["a.py", "b.py"], totalEntries: 3, truncated: true, nextOffset: 2 });
  expect(await f.call("list_dir", { offset: 2 })).toEqual({ entries: ["c.py"], totalEntries: 3, truncated: false, nextOffset: null });
  await f.call("grep", { pattern: "rate", limit: 1 });
  await f.call("report_progress", { ...plan, evidence: ["a.py"] });
  await expect(f.call("report_progress", { ...plan, evidence: ["b.py"] })).rejects.toThrow("observed repository file");
});

test("source observation snapshots expose successful reads and returned search hits without listing or caller mutation", async () => {
  const f = await fixture({ "a.py": "first", "b.py": "second", "c.py": "second" });
  const toolset = buildSourceReviewTools({ dir: f.dir, files: ["a.py", "b.py", "c.py"] }, f.controller.signal, () => {});
  const call = caller(toolset.tools);
  await call("use_skill", { skillId: "source-security-review", reason: "Inspect source evidence." });
  await call("report_progress", plan);
  expect(toolset.observedFiles()).toEqual([]);
  await call("list_dir", {});
  await expect(call("read_file", { path: "missing.py" })).rejects.toThrow();
  expect(toolset.observedFiles()).toEqual([]);
  await call("read_file", { path: "./a.py" });
  await call("grep", { pattern: "second", limit: 1 });
  expect(toolset.observedFiles()).toEqual(["a.py", "b.py"]);
  toolset.observedFiles().push("c.py");
  expect(toolset.observedFiles()).toEqual(["a.py", "b.py"]);
});

test("paged reads and searches preserve hidden, traversal and symlink exclusions", async () => {
  const f = await fixture({ "app.py": "visible", ".env": "fixture-secret", "tests/test_app.py": "supplied" });
  symlinkSync(join(f.dir, ".env"), join(f.dir, "link.py"));
  for (const path of [".env", "../outside.py", "link.py"]) {
    await expect(f.call("read_file", { path })).rejects.toThrow();
    await expect(f.call("grep", { pattern: "fixture-secret", path })).rejects.toThrow();
  }
  expect((await f.call<SearchPage>("grep", { pattern: "fixture-secret" })).hits).toEqual([]);
});

test("edit_file changes one exact source fragment in a large file and rejects ungrounded or ambiguous edits", async () => {
  const original = "# padding\n".repeat(15_000) + "def add(a, b): return a - b\n";
  const f = await fixture({ "app.py": original, "tests/test_app.py": "assert add(1, 2) == 3\n" }, true);
  const edit = { path: "app.py", oldText: "return a - b", newText: "return a + b" };
  await expect(f.call("edit_file", edit)).rejects.toThrow("source-remediation");
  await f.call("use_skill", { skillId: "source-remediation", reason: "Correct the observed arithmetic mismatch." });
  await expect(f.call("edit_file", edit)).rejects.toThrow("confirmed source-backed finding");
  await f.call("read_file", { path: "app.py", startLine: 15_001 });
  await f.call("report_finding", { id: "arithmetic", title: "Arithmetic mismatch", severity: "low", confidence: "confirmed", evidence: ["app.py"], summary: "The addition function subtracts.", recommendation: "Use addition." });
  await expect(f.call("edit_file", { ...edit, oldText: "# padding" })).rejects.toThrow("more than once");
  await expect(f.call("edit_file", { ...edit, oldText: "not present" })).rejects.toThrow("not found");
  await expect(f.call("edit_file", { ...edit, path: "tests/test_app.py", findingId: "arithmetic" })).rejects.toThrow("only application source");
  expect(await f.call("edit_file", edit)).toEqual({ ok: true, path: "app.py", findingIds: ["arithmetic"] });
  expect(readFileSync(join(f.dir, "app.py"), "utf8")).toBe(original.replace(edit.oldText, edit.newText));
  expect(f.toolset.changeFindings()).toEqual({ "app.py": ["arithmetic"] });
  await f.call("edit_file", { path: "app.py", oldText: "def add(a, b): return a + b\n", newText: "" });
  expect(readFileSync(join(f.dir, "app.py"), "utf8")).toBe("# padding\n".repeat(15_000));
});

test("Red source review cannot acquire editing tools even when remediation is requested", async () => {
  const f = await fixture({ "app.py": "source" });
  const events: EventInput[] = [];
  const red = buildSourceReviewTools(f.workspace, f.controller.signal, event => events.push(event), true, "red");
  expect(red.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["read_file", "grep", "report_finding"]));
  expect(red.tools.some(tool => ["write_file", "edit_file", "inspect_diff"].includes(tool.name))).toBe(false);
  const call = caller(red.tools);
  await call("use_skill", { skillId: "source-security-review", reason: "Inspect source evidence." });
  await call("report_progress", plan);
  await call("read_file", { path: "app.py" });
  await call("report_finding", { id: "context", title: "Source context", severity: "info", confidence: "potential", evidence: ["app.py"], summary: "Source inspected.", recommendation: "Review intended behavior." });
  expect(events.at(-1)).toMatchObject({ type: "finding_reported", agentRole: "red", stage: "REVIEW" });
});

test("existing regression repair supports exact source edits with its protected test boundary", async () => {
  const f = await fixture({ "app.py": "return left - right\n", "tests/test_app.py": "supplied" });
  const repair = buildLocalRepairTools({ workspace: f.workspace, signal: f.controller.signal, onEvent: () => {}, remainingTimeoutMs: () => 1000, onTestResult: () => undefined, runner: { prepare: async () => {}, cleanup: async () => {}, runTests: async () => { throw new Error("unused"); } } });
  const call = caller(repair.tools);
  await call("use_skill", { skillId: "minimal-repair", reason: "Apply the supplied regression's source correction." });
  await call("report_progress", plan);
  await call("edit_file", { path: "app.py", oldText: "left - right", newText: "left + right" });
  expect(readFileSync(join(f.dir, "app.py"), "utf8")).toBe("return left + right\n");
  await expect(call("edit_file", { path: "tests/test_app.py", oldText: "supplied", newText: "changed" })).rejects.toThrow("only application source");
});
