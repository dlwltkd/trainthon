import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Split, Task } from "@vouch/protocol";

/** Loads a task definition from bench/tasks/<id>/task.json. */
export function loadTask(benchDir: string, taskId: string): Task {
  const path = join(benchDir, "tasks", taskId, "task.json");
  const raw = readFileSync(path, "utf8");
  const task = JSON.parse(raw) as Task;
  if (task.id !== taskId) {
    throw new Error(
      `task id mismatch: directory "${taskId}" but task.json has "${task.id}"`,
    );
  }
  return task;
}

export function listTasks(benchDir: string, split?: Split): Task[] {
  const dir = join(benchDir, "tasks");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "task.json")))
    .map((e) => loadTask(benchDir, e.name))
    .filter((t) => (split ? t.split === split : true))
    .sort((a, b) => a.id.localeCompare(b.id));
}
