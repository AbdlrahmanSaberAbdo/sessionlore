import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// Bundles the CLI and every internal workspace package into the one published `sessionlore` package.
export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: "esm",
  platform: "node",
  // Old enough that the Node version check in bin.js runs and explains itself on unsupported Node.
  target: "node18",
  splitting: true,
  clean: true,
  noExternal: [/^@sessionlore\//],
  // transformers.js ships native binaries and is loaded at runtime; its model is downloaded on first use (ADR 0004).
  external: ["@huggingface/transformers"],
  // Keep `node:` prefixes: `node:sqlite` exists only under its prefixed name.
  removeNodeProtocol: false,
  banner: { js: "#!/usr/bin/env node" },
  // Ship the dashboard UI (built first by the `build` script) as static files next to bin.js.
  onSuccess: async () => {
    const ui = fileURLToPath(new URL("../ui/dist/", import.meta.url));
    if (!existsSync(join(ui, "index.html"))) throw new Error("The dashboard UI is not built; run `pnpm --filter @sessionlore/ui build` first.");
    cpSync(ui, fileURLToPath(new URL("./dist/ui/", import.meta.url)), { recursive: true });
  },
});
