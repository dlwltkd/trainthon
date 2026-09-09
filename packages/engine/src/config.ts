import { createHash } from "node:crypto";
import type { RunConfig } from "@vouch/protocol";

/**
 * Deterministic short hash over the parameters that must be frozen for a fair
 * comparison. Recorded on every run so pre-registration can be verified.
 */
export function configHash(config: RunConfig, taskId: string): string {
  const canonical = JSON.stringify({
    model: config.model,
    seed: config.seed,
    budgets: config.budgets,
    condition: config.condition,
    graderVersion: config.graderVersion,
    taskId,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
