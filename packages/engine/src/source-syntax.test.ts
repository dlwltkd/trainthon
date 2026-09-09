import { afterEach, expect, test, vi } from "vitest";
import { checkSourceSyntax } from "./source-syntax.js";

afterEach(() => vi.unstubAllEnvs());

test("parses Python as text without running imports or top-level statements", async () => {
  const result = await checkSourceSyntax("app.py", "import nonexistent_vouch_probe_dependency\nraise RuntimeError('must never execute')\n", new AbortController().signal);
  expect(result).toEqual({ status: "valid", parser: "python-ast" });
});

test("returns bounded syntax locations without copying source into diagnostics", async () => {
  const result = await checkSourceSyntax("app.py", "def broken(:\n    return 'private-source-marker'\n", new AbortController().signal);
  expect(result).toMatchObject({ status: "invalid", parser: "python-ast", reason: "syntax_error", line: 1, column: expect.any(Number) });
  expect(JSON.stringify(result)).not.toContain("private-source-marker");
});

test("distinguishes unsupported languages and parser capacity from successful checks", async () => {
  expect(await checkSourceSyntax("app.ts", "not valid TypeScript", new AbortController().signal)).toEqual({ status: "unsupported" });
  expect(await checkSourceSyntax("app.py", "가".repeat(700_000), new AbortController().signal)).toMatchObject({ status: "unavailable", reason: "parser_limit" });
});

test("honors cancellation before launching the parser", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled fixture"));
  await expect(checkSourceSyntax("app.py", "pass\n", controller.signal)).rejects.toThrow("cancelled fixture");
});

test("cancels an already launched parser without returning a successful check", async () => {
  const controller = new AbortController();
  const result = checkSourceSyntax("app.py", "pass\n", controller.signal);
  controller.abort(new Error("cancelled running parser"));
  await expect(result).rejects.toThrow("cancelled running parser");
});

test("reports a missing parser as unavailable instead of valid or invalid source", async () => {
  vi.stubEnv("PATH", "/nonexistent-vouch-parser-fixture");
  expect(await checkSourceSyntax("app.py", "pass\n", new AbortController().signal)).toEqual({ status: "unavailable", parser: "python-ast", reason: "parser_unavailable" });
});
