import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    pool: "forks",
    // node:sqlite still emits an ExperimentalWarning on every test file.
    poolOptions: { forks: { execArgv: ["--disable-warning=ExperimentalWarning"] } },
  },
});
