import { parseArgs } from "node:util";
import { allAdapters } from "@sessionlore/adapters";
import { App, loadConfig, storePath, type Adapter, type Clock, type Embedder, type Env, type ModelProvider } from "@sessionlore/core";
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
  warn(text: string): void;
  /** `--last N`: limit a Scan to the N most recent Sessions. */
  last?: number;
  /** Positional arguments after the command name. */
  args: string[];
  out(text: string): void;
}

interface Command {
  summary: string;
  run(ctx: CommandContext): Promise<void> | void;
}

const commands: Record<string, Command> = {
  scan: {
    summary: "Read Sessions from every Harness on this machine into the local store",
    async run({ app, json, last, out, warn }) {
      const result = await app.scan({ last });
      for (const warning of result.harnesses.flatMap((h) => h.warnings)) warn(`Warning: ${warning}\n`);
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
  session: {
    summary: "Show one stored Session with its messages: session <id>",
    run({ app, json, args, out }) {
      const [id] = args;
      if (!id) throw new Error("Which Session? Usage: sessionlore session <id>");
      const session = app.getSession(id);
      if (!session) throw new Error(`No stored Session has id ${id}. Run \`sessionlore sessions\` to list them.`);
      if (json) return out(JSON.stringify({ session }, null, 2) + "\n");
      out(`${session.harness}  ${session.project?.name ?? "(no Project)"}  ${session.startedAt}  ${session.model ?? ""}\n\n`);
      for (const m of session.messages) {
        out(m.role === "tool" ? `  [tool] ${m.name} (${m.status ?? "unknown"})\n` : `${m.role}: ${m.text}\n`);
      }
    },
  },
};

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function usage(): string {
  const lines = Object.entries(commands).map(([name, c]) => `  ${name.padEnd(10)} ${c.summary}`);
  return (
    `Usage: sessionlore <command> [--json]\n\nCommands:\n${lines.join("\n")}\n\n` +
    `Options:\n  --json       Machine-readable output\n  --last N     scan: read only the N most recent Sessions\n`
  );
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
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
        last: { type: "string" },
      },
    });
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${usage()}`);
    return 2;
  }

  const [name, ...args] = parsed.positionals;
  if (!name || parsed.values.help) {
    (name ? io.stdout : io.stderr)(usage());
    return name ? 0 : 2;
  }
  const command = commands[name];
  if (!command) {
    io.stderr(`Unknown command: ${name}\n\n${usage()}`);
    return 2;
  }

  let last: number | undefined;
  if (parsed.values.last !== undefined) {
    last = /^\d+$/.test(parsed.values.last) ? Number(parsed.values.last) : 0;
    if (last < 1) {
      io.stderr(`--last takes a positive whole number of Sessions, not "${parsed.values.last}"\n\n${usage()}`);
      return 2;
    }
  }

  let app: App | undefined;
  try {
    const config = loadConfig(io.homeDir);
    app = App.open({
      storePath: storePath(io.homeDir),
      harnessContext: { homeDir: io.homeDir, env: io.env },
      adapters: io.adapters ?? allAdapters,
      clock: io.clock,
      modelProvider: io.modelProvider,
      embedder: io.embedder,
      projectFilter: config.projects,
    });
    await command.run({ app, json: parsed.values.json ?? false, last, args, out: io.stdout, warn: io.stderr });
    return 0;
  } catch (error) {
    io.stderr(`sessionlore ${name} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    app?.close();
  }
}
