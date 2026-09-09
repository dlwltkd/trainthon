import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const source = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      ["protocol", "engine", "sandbox", "model", "grader", "skills"].map((name) => [`@vouch/${name}`, source(name)]),
    ),
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
