import { defineConfig } from "vitest/config";

export default defineConfig({
  // The UI's smoke test renders React components.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}"],
    pool: "forks",
    // node:sqlite still emits an ExperimentalWarning on every test file.
    poolOptions: { forks: { execArgv: ["--disable-warning=ExperimentalWarning"] } },
  },
});
