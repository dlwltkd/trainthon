import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { HarnessEvent } from "@vouch/protocol";

function label(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 240);
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function duration(ms: number | undefined): string {
  return ms === undefined ? "" : ` (${(Math.max(0, ms) / 1000).toFixed(1)}s)`;
}

export function createRunProgress(
  runsDir: string,
  write: (line: string) => void = (line) => { process.stderr.write(line); },
): { onEvent: (event: HarnessEvent) => void; stop: () => void } {
  let startedAt: number | undefined;
  let lastOutputAt = 0;
  let activity = "waiting for the next run event";
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const tools = new Map<string, number>();

  const print = (message: string): void => {
    const now = Date.now();
    write(`[${elapsed(now - (startedAt ?? now))}] ${label(message)}\n`);
    lastOutputAt = now;
  };
  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    tools.clear();
  };

  const onEvent = (event: HarnessEvent): void => {
    if (stopped) return;
    startedAt ??= Date.now();
    const role = "agentRole" in event && event.agentRole ? `${event.agentRole} ` : "";
    switch (event.type) {
      case "run_start": {
        const logPath = event.runKind === "local_repository"
          ? resolve(runsDir, event.runId, "events.jsonl")
          : resolve(runsDir, `${event.runId}.jsonl`);
        print(`run started: ${label(event.runId)}`);
        print(`events: ${label(logPath)}`);
        activity = "starting the run";
        break;
      }
      case "state_change":
        activity = event.to === "DONE" ? "finishing the run" : `stage ${event.to.toLowerCase()}`;
        if (event.to !== "DONE") print(activity);
        break;
      case "repository_snapshot":
        print(`repository snapshot: ${label(event.name)} @ ${label(event.commit.slice(0, 12))}, ${event.files.length} files`);
        activity = "preparing the repository runtime";
        break;
      case "action_summary":
        if (event.callId) break;
        activity = `${role}${label(event.summary)}`;
        print(activity);
        break;
      case "role_assigned":
        print(`${event.role} assigned: ${label(event.provider ?? event.runner)}${event.model ? ` / ${label(event.model)}` : ""}`);
        activity = `waiting for ${event.role}'s next action`;
        break;
      case "guidance_configured":
        print(`${role}guidance: ${label(event.id)}@${label(event.version)}`);
        break;
      case "tool_call":
        if (event.callId) tools.set(event.callId, Date.now());
        activity = `${role}tool ${label(event.name)}`;
        print(`${activity} started`);
        break;
      case "tool_result":
      case "tool_error": {
        const start = event.callId ? tools.get(event.callId) : undefined;
        const ms = event.durationMs ?? (start === undefined ? undefined : Date.now() - start);
        if (event.callId) tools.delete(event.callId);
        const outcome = event.type === "tool_error" || event.outcome === "failed" ? "failed" : "completed";
        print(`${role}tool ${label(event.name)} ${outcome}${duration(ms)}`);
        activity = `waiting for ${role ? `${role.trim()}'s` : "the agent's"} next action`;
        break;
      }
      case "test_run":
        print(`tests ${label(event.phase)}: ${label(event.outcome)}, ${event.testsPassed} passed / ${event.testsFailed} failed / ${event.testsSkipped} skipped${duration(event.durationMs)}`);
        activity = "waiting for the next verification step";
        break;
      case "model_msg":
        if (event.role !== "assistant") break;
        print(`${role}model step finished`);
        activity = `${role}waiting for the next agent action`;
        break;
      case "agent_summary":
        print(`${role}summary saved`);
        break;
      case "file_change":
        print(`${role}source change saved`);
        break;
      case "run_end":
        try { print(`run ended: ${event.status}${duration(event.elapsedMs)}`); }
        finally { stop(); }
        return;
    }
    if (timer === undefined) {
      timer = setInterval(() => {
        if (Date.now() - lastOutputAt < 10_000) return;
        try { print(`still waiting: ${activity}`); }
        catch { stop(); }
      }, 1000);
      timer.unref();
    }
  };

  return { onEvent, stop };
}
