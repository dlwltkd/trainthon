import type { DoctorOptions } from "./doctor.js";
import { resolveLiveRoleModels, type Flags } from "./run-options.js";

const MODEL_FLAGS = new Set([
  "model", "provider", "base-url", "api-key-env",
  "red-model", "red-provider", "red-base-url", "red-api-key-env",
]);

export function parseDoctorOptions(
  flags: Flags,
  env: NodeJS.ProcessEnv = process.env,
): DoctorOptions {
  for (const [key, flagValue] of Object.entries(flags)) {
    if (key === "live") {
      if (flagValue !== true) throw new Error("--live does not take a value");
      continue;
    }
    if (!MODEL_FLAGS.has(key)) throw new Error(`unknown flag: --${key}`);
    if (flagValue === true) throw new Error(`--${key} requires a value`);
  }

  const models = resolveLiveRoleModels(flags, env);
  return {
    live: flags["live"] === true,
    checks: [
      { role: "blue", model: models.blue },
      ...(models.red ? [{ role: "red" as const, model: models.red }] : []),
    ],
  };
}
