import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export interface SourceSyntaxCheck {
  status: "valid" | "invalid" | "unavailable" | "unsupported";
  parser?: "python-ast";
  line?: number;
  column?: number;
  reason?: "syntax_error" | "parser_limit" | "parser_unavailable";
}

// The only program the subprocess receives. Repository text is stdin data,
// never a script, module import, filename to execute, or shell argument.
const PYTHON_PARSER = `import ast,json,resource,sys
resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
source = sys.stdin.buffer.read(2000001)
if len(source) > 2000000:
 print(json.dumps(dict(status="unavailable", reason="parser_limit")))
else:
 try:
  ast.parse(source.decode("utf-8"))
  print(json.dumps(dict(status="valid")))
 except SyntaxError as error:
  print(json.dumps(dict(status="invalid", reason="syntax_error", line=error.lineno, column=error.offset)))
 except (ValueError, UnicodeError):
  print(json.dumps(dict(status="invalid", reason="syntax_error")))
 except (RecursionError, MemoryError):
  print(json.dumps(dict(status="unavailable", reason="parser_limit")))
`;

export async function checkSourceSyntax(path: string, source: string, signal: AbortSignal): Promise<SourceSyntaxCheck> {
  signal.throwIfAborted();
  if (!path.endsWith(".py")) return { status: "unsupported" };
  if (Buffer.byteLength(source) > 2_000_000) return { status: "unavailable", parser: "python-ast", reason: "parser_limit" };
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-I", "-S", "-B", "-c", PYTHON_PARSER], {
      cwd: tmpdir(), env: { PATH: process.env.PATH, LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "", limited = false;
    const stop = () => { child.kill("SIGKILL"); };
    const timer = setTimeout(() => { limited = true; stop(); }, 5_000);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 2_000) { limited = true; stop(); return; }
      output += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {});
    child.once("error", () => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else resolve({ status: "unavailable", parser: "python-ast", reason: "parser_unavailable" });
    });
    child.once("close", code => {
      cleanup();
      if (signal.aborted) { reject(signal.reason); return; }
      try {
        if (code !== 0 || limited) throw new Error("parser unavailable");
        const result = JSON.parse(output);
        if (result.status === "valid") { resolve({ status: "valid", parser: "python-ast" }); return; }
        if (result.status === "invalid" && result.reason === "syntax_error") {
          resolve({ status: "invalid", parser: "python-ast", reason: "syntax_error",
            ...(Number.isSafeInteger(result.line) && result.line > 0 ? { line: result.line } : {}),
            ...(Number.isSafeInteger(result.column) && result.column > 0 ? { column: result.column } : {}),
          });
          return;
        }
        if (result.status === "unavailable" && result.reason === "parser_limit") {
          resolve({ status: "unavailable", parser: "python-ast", reason: "parser_limit" });
          return;
        }
      } catch { /* Parser failures never count as valid source. */ }
      resolve({ status: "unavailable", parser: "python-ast", reason: limited || code !== 0 ? "parser_limit" : "parser_unavailable" });
    });
    child.stdin.end(source);
  });
}
