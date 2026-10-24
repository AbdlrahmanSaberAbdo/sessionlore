import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  /**
   * Lines the person types, one per question the CLI asks; each question and
   * answer is echoed to stdout as a terminal would show it. Omit to run
   * without a terminal, as in a pipe or CI. Asking more questions than there
   * are answers fails the test.
   */
  answers?: string[];
  /** Abort it to interrupt the command, as Ctrl-C would. */
  signal?: AbortSignal;
  /** Called with the URL `serve` would open in the browser. */
  openBrowser?: (url: string) => void;
  /** Folder of built UI files `serve` serves. */
  uiDir?: string;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON, for commands run with `--json`. */
  json<T = any>(): T;
}

/** Writes sessionlore's config file in the fixture home. Pass a string to write it verbatim. */
export function writeConfig(home: FixtureHome, config: unknown): string {
  const file = home.resolve(join(".sessionlore", "config.json"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config, null, 2));
  return file;
}

export const fixedClock =(iso: string): Clock => ({ now: () => new Date(iso) });

export async function runCli(home: FixtureHome, args: string[], options: RunOptions = {}): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const answers = options.answers && [...options.answers];
  const ask =
    answers &&
    (async (question: string) => {
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`The CLI asked "${question}" but the test supplied no more answers`);
      stdout += `${question}${answer}\n`;
      return answer;
    });
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
    ask,
    signal: options.signal,
    clock: options.clock ?? fixedClock("2026-06-01T12:00:00.000Z"),
    modelProvider: options.modelProvider,
    embedder: options.embedder,
    openBrowser: options.openBrowser,
    uiDir: options.uiDir,
  });
  return {
    exitCode,
    stdout,
    stderr,
    json: () => JSON.parse(stdout),
  };
}
