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

const { main } = await import("./main.js");
const { systemClock } = await import("@sessionlore/core");

process.exitCode = await main(process.argv.slice(2), {
  homeDir: homedir(),
  env: process.env,
  nodeVersion: process.versions.node,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  clock: systemClock,
});
