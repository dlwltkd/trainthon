import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CODEX_DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "apps", "plugins", "browser_use", "browser_use_external",
  "computer_use", "image_generation", "view_image", "multi_agent", "skill_search", "in_app_browser",
];

const answerSchema = (sourcePath: string) => ({
  type: "object", additionalProperties: false, required: ["verdict", "summary", "evidence", "edits"],
  properties: {
    verdict: { type: "string", enum: ["issue_present", "issue_absent", "uncertain"] },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "quote"], properties: { path: { type: "string", enum: [sourcePath] }, quote: { type: "string" } } } },
    edits: { type: "array", items: { type: "object", additionalProperties: false, required: ["oldText", "newText"], properties: { oldText: { type: "string" }, newText: { type: "string" } } } },
  },
});

export async function runCodexSource(options: { dir: string; prompt: string; source: string; sourcePath?: string; model: string; maxWallMs: number; signal: AbortSignal }) {
  const sourcePath = options.sourcePath ?? "bottle.py";
  const schemaPath = join(options.dir, "answer-schema.json"), outputPath = join(options.dir, "answer.json");
  writeFileSync(schemaPath, JSON.stringify(answerSchema(sourcePath)), { mode: 0o600 });
  const prompt = `${options.prompt}\nFor this source-only Codex condition, the entire original ${sourcePath} is provided below. Return source replacements in an additional edits array: [{"oldText":"exact unique existing text","newText":"replacement"}]. Use [] if no correction is needed. Do not call tools. The harness applies the replacements to a private candidate after your answer.\n<source path="${sourcePath}">\n${options.source}\n</source>`;
  writeFileSync(join(options.dir, "prompt.txt"), prompt, { mode: 0o600 });
  const args = ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-m", options.model,
    "-c", 'web_search="disabled"', "--enable", "skip_host_skill_discovery", "--json", "--output-schema", schemaPath, "-o", outputPath];
  for (const feature of CODEX_DISABLED_FEATURES) args.push("--disable", feature);
  args.push("-");
  writeFileSync(join(options.dir, "invocation.json"), JSON.stringify({ executable: "codex", args, model: options.model }, null, 2), { mode: 0o600 });
  options.signal.throwIfAborted();
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) || name === "OPENAI_API_KEY"));
  const child = spawn("codex", args, { cwd: options.dir, env: childEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let pending = "", bytes = 0, failure: string | undefined;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already exited */ } };
  const stop = (reason: string) => {
    failure ??= reason;
    kill("SIGINT");
    forceTimer ??= setTimeout(() => kill("SIGKILL"), 2_000);
  };
  const abort = () => stop("evaluation cancelled");
  options.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop("Codex exceeded the registered wall-time allowance"), options.maxWallMs);
  const startedAt = Date.now();
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 4_000_000) { stop("Codex output exceeded the artifact allowance"); return; }
    pending += chunk.toString("utf8");
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        // Native reasoning text is discarded. The artifact retains execution metadata only.
        appendFileSync(join(options.dir, "events.jsonl"), JSON.stringify({ type: event.type, elapsedMs: Date.now() - startedAt, ...(event.item?.type ? { itemType: event.item.type } : {}) }) + "\n", { mode: 0o600 });
        if (event.type === "turn.completed" && Number.isFinite(event.usage?.input_tokens) && Number.isFinite(event.usage?.output_tokens)) {
          usage = { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens };
        }
        if (event.item?.type && !["agent_message", "reasoning", "error", "todo_list"].includes(event.item.type)) stop("unexpected tool activity in the source-only Codex condition");
        if (event.type === "turn.failed") failure ??= "Codex reported a failed model turn";
      } catch { /* Non-JSON process output is not published. */ }
    }
  });
  child.stderr.resume();
  child.stdin.on("error", () => { /* Process exit is handled below. */ });
  child.stdin.end(prompt);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new Error("could not launch the Codex CLI")));
      child.once("close", code => code === 0 && !failure ? resolve() : reject(new Error(failure ?? `Codex exited with status ${code}`)));
    });
    const text = readFileSync(outputPath, "utf8");
    if (Buffer.byteLength(text) > 400_000) throw new Error("Codex answer exceeds 400 KB");
    return { text, usage };
  } finally {
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    options.signal.removeEventListener("abort", abort);
  }
}
