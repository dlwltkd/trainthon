import type { ExecResult } from "./exec.js";
import type { StructuredTestResult, TestSelection } from "./docker-project.js";

export const PYTEST_EVIDENCE_MARKER = "__VOUCH_PYTEST_V1__";
export interface PytestEvidence {
  version: 1;
  collected: Array<{ nodeid: string; file: string }>;
  reports: Array<{
    nodeid: string;
    when: "setup" | "call" | "teardown";
    outcome: "passed" | "failed" | "skipped";
    assertion: boolean;
    expectedFailure: boolean;
  }>;
  errors: string[];
}

export const PYTEST_LAUNCHER = `import base64
import json
import os
import sys
from pathlib import Path

write, finish = os.write, os._exit
encode, dumps = base64.b64encode, json.dumps
sys.path.insert(0, "/deps")
import pytest
sys.path.insert(0, "/repo")

evidence = {"version": 1, "collected": [], "reports": [], "errors": []}

class EvidencePlugin:
    def pytest_collection_finish(self, session):
        for item in session.items:
            evidence["collected"].append({"nodeid": item.nodeid, "file": str(item.path.relative_to(Path("/repo")))})

    def pytest_collectreport(self, report):
        if report.failed or report.skipped:
            evidence["errors"].append("collection did not complete: " + report.nodeid)

    def pytest_deselected(self, items):
        if items:
            evidence["errors"].append("tests were deselected")

    def pytest_internalerror(self, excrepr, excinfo):
        evidence["errors"].append("pytest internal error")

    @pytest.hookimpl(hookwrapper=True)
    def pytest_runtest_makereport(self, item, call):
        result = yield
        report = result.get_result()
        assertion = (call.when == "call" and call.excinfo is not None
                     and call.excinfo.errisinstance(AssertionError)
                     and any(Path(str(entry.path)) == item.path for entry in call.excinfo.traceback))
        evidence["reports"].append({"nodeid": report.nodeid, "when": report.when,
            "outcome": report.outcome, "assertion": bool(assertion),
            "expectedFailure": hasattr(report, "wasxfail")})

selection, regression = sys.argv[1:]
args = ["-c", "/vouch/pytest.ini", "--rootdir=/repo", "--confcutdir=/repo",
        "-p", "no:cacheprovider", "--basetemp=/tmp/pytest", "--tb=short", "-q"]
args.append("/repo/" + regression if selection == "regression" else "/repo")
code = int(pytest.main(args, plugins=[EvidencePlugin()]))
sys.stdout.flush()
sys.stderr.flush()
payload = b"\\n${PYTEST_EVIDENCE_MARKER}" + encode(dumps(evidence).encode()) + b"\\n"
while payload:
    payload = payload[write(1, payload):]
finish(code)
`;

export function classifyPytestEvidence(evidence: unknown, execution: ExecResult, selection: TestSelection, regressionPath: string): StructuredTestResult {
  const base: StructuredTestResult = {
    status: "invalid", passed: false, output: `${execution.stdout}\n${execution.stderr}`.trim().slice(-16_000),
    exitCode: execution.exitCode, timedOut: execution.timedOut, cancelled: Boolean(execution.cancelled),
    testsPassed: 0, testsFailed: 0, testsSkipped: 0, collectedFiles: [], testManifest: [],
  };
  if (execution.cancelled) return { ...base, status: "cancelled", reason: "test execution cancelled" };
  if (execution.timedOut) return { ...base, status: "timeout", reason: "test execution timed out" };
  if (!evidence || typeof evidence !== "object") return { ...base, status: "error", reason: "pytest did not produce structured test evidence" };
  const report = evidence as PytestEvidence;
  if (report.version !== 1 || !Array.isArray(report.collected) || !Array.isArray(report.reports) || !Array.isArray(report.errors)) {
    return { ...base, reason: "invalid pytest evidence" };
  }
  if (report.errors.length) return { ...base, status: "error", reason: "pytest collection or internal error" };
  const items = new Map<string, PytestEvidence["reports"]>();
  for (const item of report.collected) {
    if (!item || typeof item.file !== "string" || typeof item.nodeid !== "string" ||
        item.file.includes("\\") || /[\0\r\n]/.test(item.file) || item.file.split("/").some(part => !part || part === "." || part === "..") ||
        !item.nodeid.startsWith(`${item.file}::`) || items.has(item.nodeid)) {
      return { ...base, reason: "invalid or duplicate collected test identity" };
    }
    items.set(item.nodeid, []);
  }
  base.collectedFiles = [...new Set(report.collected.map(item => item.file))].sort();
  if (selection === "regression" && (base.collectedFiles.length !== 1 || base.collectedFiles[0] !== regressionPath)) {
    return { ...base, reason: "designated regression was not the sole collected test file" };
  }
  if (selection === "functional" && base.collectedFiles.includes(regressionPath)) {
    return { ...base, reason: "functional suite included designated regression" };
  }
  for (const phase of report.reports) {
    if (!phase || !items.has(phase.nodeid) || !["setup", "call", "teardown"].includes(phase.when) ||
        !["passed", "failed", "skipped"].includes(phase.outcome) || typeof phase.assertion !== "boolean" || typeof phase.expectedFailure !== "boolean") {
      return { ...base, reason: "invalid test phase evidence" };
    }
    items.get(phase.nodeid)!.push(phase);
  }
  for (const [nodeid, phases] of items) {
    const setup = phases.find(p => p.when === "setup");
    const call = phases.find(p => p.when === "call");
    const teardown = phases.find(p => p.when === "teardown");
    if (new Set(phases.map(p => p.when)).size !== phases.length || !setup || !teardown || (setup.outcome === "passed" && !call)) {
      return { ...base, reason: "test phases were duplicated or did not finish" };
    }
    if (setup.outcome === "failed" || teardown.outcome !== "passed") return { ...base, status: "error", reason: "test setup or teardown failed" };
    if (setup.outcome === "skipped" && call) return { ...base, reason: "skipped setup has unexpected call evidence" };
    const skipped = phases.some(p => p.outcome === "skipped" || p.expectedFailure);
    base.testManifest.push(`${nodeid}#${skipped ? "skipped" : "run"}`);
    if (skipped) base.testsSkipped++;
    else if (call?.outcome === "passed") base.testsPassed++;
    else if (call?.outcome === "failed" && call.assertion) base.testsFailed++;
    else return { ...base, status: "error", reason: "failure was not an assertion from an executed test" };
  }
  base.testManifest.sort();
  if (!base.testsPassed && !base.testsFailed) return { ...base, reason: "no tests executed" };
  if (selection === "regression" && base.testsSkipped) return { ...base, reason: "designated regression contains skipped or expected-failure tests" };
  if (base.testsFailed) {
    if (execution.exitCode !== 1) return { ...base, reason: "assertion evidence disagrees with process exit" };
    return { ...base, status: "assertion_failed", reason: "executed test assertion failed" };
  }
  if (execution.exitCode !== 0) return { ...base, status: "error", reason: "test process exited unsuccessfully" };
  return { ...base, status: "passed", passed: true };
}
