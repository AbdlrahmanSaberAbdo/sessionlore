import { homedir } from "node:os";
import { unsupportedNodeMessage } from "./node-version.js";

// Check the Node version before loading anything that needs node:sqlite.
const versionProblem = unsupportedNodeMessage(process.versions.node);
if (versionProblem) {
  process.stderr.write(versionProblem);
  process.exit(1);
}

// node:sqlite is stable enough for sessionlore's use; hide its ExperimentalWarning.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (/SQLite/i.test(text)) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

// The AI SDK logs a console warning per call for settings a model ignores; sessionlore reports failures itself.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const { main } = await import("./main.js");
const { systemClock } = await import("@sessionlore/core");
const { localEmbedder } = await import("./local-embedder.js");

const { createInterface } = await import("node:readline/promises");
const { fileURLToPath } = await import("node:url");
const { openBrowser } = await import("./open-browser.js");

// The first Ctrl-C asks the command to stop cleanly, keeping finished work; a second one quits at once.
const interrupt = new AbortController();
process.on("SIGINT", () => {
  if (interrupt.signal.aborted) process.exit(130);
  process.stderr.write("\nStopping after the current step. Press Ctrl-C again to quit now.\n");
  interrupt.abort();
});

const ask = process.stdin.isTTY
  ? async (question: string): Promise<string> => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question, { signal: interrupt.signal });
      } catch {
        return "";
      } finally {
        rl.close();
      }
    }
  : undefined;

process.exitCode = await main(process.argv.slice(2), {
  homeDir: homedir(),
  env: process.env,
  nodeVersion: process.versions.node,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  ask,
  signal: interrupt.signal,
  clock: systemClock,
  embedder: localEmbedder({ homeDir: homedir(), notify: (text) => process.stderr.write(text) }),
  openBrowser,
  // The build copies the dashboard UI next to bin.js.
  uiDir: fileURLToPath(new URL("./ui/", import.meta.url)),
});
