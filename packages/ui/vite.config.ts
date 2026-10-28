import { defineConfig } from "vite";

// Built to static files that the CLI package ships and the local server serves (no frontend server at runtime).
export default defineConfig({
  root: import.meta.dirname,
  esbuild: { jsx: "automatic" },
  build: { outDir: "dist", emptyOutDir: true },
  // `vite dev` proxies the API to a running `habitlore serve --port 4848 --no-open`.
  server: { proxy: { "/api": "http://127.0.0.1:4848" } },
});
