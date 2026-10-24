import { parseArgs } from "node:util";
import { allAdapters } from "@sessionlore/adapters";
import { App, storePath, type Adapter, type Clock, type Embedder, type Env, type ModelProvider } from "@sessionlore/core";
import { unsupportedNodeMessage } from "./node-version.js";

/** Everything the CLI takes from its surroundings. Seam 1 tests supply all of it. */
export interface CliEnvironment {
  homeDir: string;
  env: Env;
  nodeVersion: string;
  stdout(text: string): void;
  stderr(text: string): void;
  clock: Clock;
  modelProvider?: ModelProvider;
  embedder?: Embedder;
  /** Defaults to every Adapter sessionlore ships. */
  adapters?: readonly Adapter[];
}

interface CommandContext {
  app: App;
  json: boolean;
  out(text: string): void;
}

interface Command {
  summary: string;
  run(ctx: CommandContext): Promise<void> | void;
}

const commands: Record<string, Command> = {
  scan: {
    summary: "Read Sessions from every Harness on this machine into the local store",
    async run({ app, json, out }) {
      const result = await app.scan();
      if (json) return out(JSON.stringify(result, null, 2) + "\n");
      for (const harness of result.harnesses) {
        out(
          `${harness.name}: ${harness.added} ${plural(harness.added, "Session")} added, ` +
            `${harness.updated} updated, ${harness.unchanged} unchanged\n`,
        );
      }
    },
  },
  sessions: {
    summary: "List stored Sessions",
    run({ app, json, out }) {
      const sessions = app.listSessions();
      if (json) return out(JSON.stringify({ sessions }, null, 2) + "\n");
      if (sessions.length === 0) return out("No Sessions stored yet. Run `sessionlore scan` first.\n");
      for (const s of sessions) {
        out(`${s.startedAt}  ${s.harness}  ${s.project?.name ?? "(no Project)"}  ${s.userMessageCount} messages  ${s.id}\n`);
      }
    },
  },
};

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function usage(): string {
  const lines = Object.entries(commands).map(([name, c]) => `  ${name.padEnd(10)} ${c.summary}`);
  return `Usage: sessionlore <command> [--json]\n\nCommands:\n${lines.join("\n")}\n`;
}

/** Runs the CLI and returns its exit code. */
export async function main(argv: readonly string[], io: CliEnvironment): Promise<number> {
  const versionProblem = unsupportedNodeMessage(io.nodeVersion);
  if (versionProblem) {
    io.stderr(versionProblem);
    return 1;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { json: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } },
    });
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${usage()}`);
    return 2;
  }

  const [name] = parsed.positionals;
  if (!name || parsed.values.help) {
    (name ? io.stdout : io.stderr)(usage());
    return name ? 0 : 2;
  }
  const command = commands[name];
  if (!command) {
    io.stderr(`Unknown command: ${name}\n\n${usage()}`);
    return 2;
  }

  let app: App | undefined;
  try {
    app = App.open({
      storePath: storePath(io.homeDir),
      harnessContext: { homeDir: io.homeDir, env: io.env },
      adapters: io.adapters ?? allAdapters,
      clock: io.clock,
      modelProvider: io.modelProvider,
      embedder: io.embedder,
    });
    await command.run({ app, json: parsed.values.json ?? false, out: io.stdout });
    return 0;
  } catch (error) {
    io.stderr(`sessionlore ${name} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    app?.close();
  }
}
