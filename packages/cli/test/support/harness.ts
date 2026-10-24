import type { Clock, Embedder, ModelProvider } from "@sessionlore/core";
import type { FixtureHome } from "@sessionlore/fixtures";
import { main } from "../../src/index.js";

/**
 * Seam 1: run the sessionlore CLI in-process against a fixture home directory.
 * Tests observe only what a user would: exit code, stdout, stderr and files.
 */

export interface RunOptions {
  env?: Record<string, string | undefined>;
  clock?: Clock;
  modelProvider?: ModelProvider;
  embedder?: Embedder;
  nodeVersion?: string;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON, for commands run with `--json`. */
  json<T = any>(): T;
}

export const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });

export async function runCli(home: FixtureHome, args: string[], options: RunOptions = {}): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const exitCode = await main(args, {
    homeDir: home.path,
    env: { HOME: home.path, ...options.env },
    nodeVersion: options.nodeVersion ?? process.versions.node,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    clock: options.clock ?? fixedClock("2026-06-01T12:00:00.000Z"),
    modelProvider: options.modelProvider,
    embedder: options.embedder,
  });
  return {
    exitCode,
    stdout,
    stderr,
    json: () => JSON.parse(stdout),
  };
}
