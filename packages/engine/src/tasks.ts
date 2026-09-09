import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "@vouch/protocol";

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
