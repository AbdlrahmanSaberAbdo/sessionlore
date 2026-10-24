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
  // Keep `node:` prefixes: `node:sqlite` exists only under its prefixed name.
  removeNodeProtocol: false,
  banner: { js: "#!/usr/bin/env node" },
});
