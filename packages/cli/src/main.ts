import { parseArgs } from "node:util";
import { allAdapters } from "@sessionlore/adapters";
import {
  App,
  configPath,
  loadConfig,
  storePath,
  type Adapter,
  type Clock,
  type Embedder,
  type Env,
  type ModelProvider,
} from "@sessionlore/core";
import { resolveModelProvider, type ModelProviderResolution } from "./model-provider.js";
import { unsupportedNodeMessage } from "./node-version.js";

/** Everything the CLI takes from its surroundings. Seam 1 tests supply all of it. */
export interface CliEnvironment {
  homeDir: string;
  env: Env;
  nodeVersion: string;
  stdout(text: string): void;
  stderr(text: string): void;
  /**
   * Shows `question` and resolves to the line the person types. Absent when
   * nobody can answer (stdin is not a terminal); commands that need
   * confirmation then require `--yes`.
   */
  ask?: (question: string) => Promise<string>;
  /** Aborted when the person interrupts (Ctrl-C); long commands stop cleanly and keep finished work. */
  signal?: AbortSignal;
  clock: Clock;
  modelProvider?: ModelProvider;
  embedder?: Embedder;
  /** Defaults to every Adapter sessionlore ships. */
  adapters?: readonly Adapter[];
}

interface CommandContext {
  app: App;
  json: boolean;
  /** `--yes`: go ahead without asking for confirmation. */
  yes: boolean;
  /** Asks the person a question; absent when there is no terminal to ask on. */
  ask?: (question: string) => Promise<string>;
  /** Aborted when the person interrupts the command (Ctrl-C). */
  signal?: AbortSignal;
  /** Positional arguments after the command name. */
  args: string[];
  options: { showRedacted?: string };
  modelProvider: ModelProviderResolution;
  /** Path of the config file, for messages that tell the person what to set. */
  configFile: string;
  warn(text: string): void;
  /** `--last N`: limit a Scan to the N most recent Sessions. */
  last?: number;
  out(text: string): void;
  err(text: string): void;
}

interface Command {
  summary: string;
  /** Resolves to the exit code; nothing means success. */
  run(ctx: CommandContext): Promise<number | void> | number | void;
}

const commands: Record<string, Command> = {
  analyze: {
    summary: "Split new or changed Sessions into Tasks and label each User Message's Intent",
    async run({ app, json, yes, ask, signal, options, modelProvider, configFile, out, err }) {
      if (options.showRedacted !== undefined) {
        const request = app.redactedRequest(options.showRedacted);
        if (request === null) {
          err(`No Session with id ${options.showRedacted}. Run \`sessionlore sessions\` to list them.\n`);
          return 1;
        }
        return out(request + "\n");
      }
      if (!modelProvider.ok) {
        err(modelProvider.problem);
        return 1;
      }
      const estimate = app.estimateAnalysis();
      // With --json, stdout carries only the result; the estimate and question go to stderr.
      const say = json ? err : out;
      if (estimate.sessions === 0) {
        say("No new or changed Sessions to analyze.\n");
        if (json) out(JSON.stringify(await app.analyze(), null, 2) + "\n");
        return;
      }
      say(`${estimate.sessions} ${plural(estimate.sessions, "Session")} to analyze. Estimated use:\n`);
      for (const { model, tokens, costUsd } of estimate.models) {
        const cost = costUsd === null ? "cost unknown" : `about ${dollars(costUsd)}`;
        say(`  ${model}: about ${count(tokens.input)} input and ${count(tokens.output)} output tokens, ${cost}\n`);
      }
      const unpriced = estimate.models.filter((m) => m.costUsd === null).map((m) => m.model);
      if (unpriced.length > 0) say(unpricedHint(unpriced, configFile));
      if (!yes) {
        if (!ask) {
          err("Analysis needs confirmation before it calls the Model Provider. Run `sessionlore analyze --yes` to go ahead.\n");
          return 1;
        }
        const answer = await ask("Continue? [y/N] ");
        if (!/^\s*y(es)?\s*$/i.test(answer)) {
          say("Nothing analyzed.\n");
          return;
        }
      }
      const result = await app.analyze({ signal });
      const exitCode = result.interrupted ? interruptedExitCode : undefined;
      if (json) {
        out(JSON.stringify(result, null, 2) + "\n");
        return exitCode;
      }
      if (result.interrupted) {
        out(
          `Interrupted. ${result.remaining} ${plural(result.remaining, "Session")} left; ` +
            "run `sessionlore analyze` again to pick up where this stopped.\n",
        );
      }
      out(`${result.analyzed.length} ${plural(result.analyzed.length, "Session")} analyzed\n`);
      if (result.failed.length > 0) {
        out(`${result.failed.length} ${plural(result.failed.length, "Session")} failed:\n`);
        for (const f of result.failed) out(`  ${f.session}: ${f.error}\n`);
      }
      for (const { model, tokens, costUsd } of result.usage) {
        const cost = costUsd === null ? "cost unknown" : dollars(costUsd);
        out(`Used: ${model}: ${count(tokens.input)} input and ${count(tokens.output)} output tokens, ${cost}\n`);
      }
      return exitCode;
    },
  },
  tasks: {
    summary: "List the Tasks of analyzed Sessions with each User Message's Intent",
    run({ app, json, out }) {
      const sessions = app.listTasks();
      if (json) return out(JSON.stringify({ sessions }, null, 2) + "\n");
      if (sessions.length === 0) return out("No Sessions analyzed yet. Run `sessionlore analyze` first.\n");
      for (const s of sessions) {
        out(`${s.id}  ${s.project?.name ?? "(no Project)"}\n`);
        for (const t of s.tasks) {
          out(`  ${t.title}\n`);
          for (const m of t.userMessages) out(`    [${m.intent}] ${firstLine(m.text)}\n`);
        }
      }
    },
  },
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
  workflows: {
    summary: "List Workflows (Clusters of similar Tasks that pass the Repeat Rule) and near-Workflows",
    run({ app, json, out }) {
      const result = app.listWorkflows();
      if (json) return out(JSON.stringify(result, null, 2) + "\n");
      const { minMembers, minSessions, windowDays } = result.repeatRule;
      out(`Repeat Rule: ${minMembers} Tasks across ${minSessions} Sessions within ${windowDays} days\n`);
      if (result.workflows.length === 0 && result.nearWorkflows.length === 0) {
        return out("No Workflows yet. Run `sessionlore analyze` after a few more Sessions.\n");
      }
      for (const w of result.workflows) {
        out(`\n${w.name}  (${w.counted.tasks} Tasks in ${w.counted.sessions} Sessions)\n`);
        for (const t of w.tasks) out(`  ${t.at.slice(0, 10)}  ${t.harness}  ${t.title}\n`);
      }
      if (result.nearWorkflows.length > 0) out("\nNear-Workflows:\n");
      for (const w of result.nearWorkflows) {
        const needs = [
          w.needs.tasks > 0 ? `${w.needs.tasks} more ${plural(w.needs.tasks, "Task")}` : "",
          w.needs.sessions > 0 ? `${w.needs.sessions} more ${plural(w.needs.sessions, "Session")}` : "",
        ].filter(Boolean);
        out(`  ${w.name}  (needs ${needs.join(" and ")})\n`);
      }
    },
  },
  workflow: {
    summary: "Show one Workflow or Cluster with its Tasks: workflow <id>",
    run({ app, json, args, out }) {
      const [id] = args;
      if (!id || !/^\d+$/.test(id)) throw new Error("Which Workflow? Usage: sessionlore workflow <id>");
      const workflow = app.getWorkflow(Number(id));
      if (!workflow) throw new Error(`No Workflow has id ${id}. Run \`sessionlore workflows\` to list them.`);
      if (json) return out(JSON.stringify({ workflow }, null, 2) + "\n");
      out(`${workflow.name}  (${workflow.counted.tasks} Tasks in ${workflow.counted.sessions} Sessions)\n`);
      for (const t of workflow.tasks) out(`  ${t.at.slice(0, 10)}  ${t.harness}  ${t.title}\n`);
    },
  },
  recluster: {
    summary: "Rebuild every Cluster from scratch, mapping old Workflows onto the new ones",
    async run({ app, json, signal, out }) {
      const result = await app.recluster({ signal });
      if (json) return out(JSON.stringify(result, null, 2) + "\n");
      const sections = [
        ["Clusters", result],
        ["Correction Clusters", result.corrections],
      ] as const;
      if (sections.every(([, s]) => s.mapped.length === 0 && s.created.length === 0)) {
        return out("No Clusters yet. Run `sessionlore analyze` first.\n");
      }
      for (const [title, { mapped, created }] of sections) {
        if (mapped.length === 0 && created.length === 0) continue;
        out(`${title}:\n`);
        for (const { from, to } of mapped) out(from.id === to.id ? `  ${from.name}: kept\n` : `  ${from.name} -> ${to.name}\n`);
        for (const c of created) out(`  New: ${c.name}\n`);
      }
      for (const { model, tokens, costUsd } of result.usage) {
        const cost = costUsd === null ? "cost unknown" : dollars(costUsd);
        out(`Used: ${model}: ${count(tokens.input)} input and ${count(tokens.output)} output tokens, ${cost}\n`);
      }
    },
  },
  corrections: {
    summary: "List Correction Clusters (similar Corrections across all Tasks) that pass the Repeat Rule, and near ones",
    run({ app, json, out }) {
      const result = app.listCorrections();
      if (json) return out(JSON.stringify(result, null, 2) + "\n");
      const { minMembers, minSessions, windowDays } = result.repeatRule;
      out(`Repeat Rule: ${minMembers} Corrections across ${minSessions} Sessions within ${windowDays} days\n`);
      if (result.correctionClusters.length === 0 && result.nearCorrectionClusters.length === 0) {
        return out("No Correction Clusters yet. Run `sessionlore analyze` after a few more Sessions.\n");
      }
      for (const c of result.correctionClusters) {
        out(`\n${c.name}  (${c.counted.corrections} Corrections in ${c.counted.sessions} Sessions)\n`);
        for (const m of c.corrections) out(`  ${m.at.slice(0, 10)}  ${m.harness}  ${m.session}  ${m.text}\n`);
      }
      if (result.nearCorrectionClusters.length > 0) out("\nNear Correction Clusters:\n");
      for (const c of result.nearCorrectionClusters) {
        const needs = [
          c.needs.corrections > 0 ? `${c.needs.corrections} more ${plural(c.needs.corrections, "Correction")}` : "",
          c.needs.sessions > 0 ? `${c.needs.sessions} more ${plural(c.needs.sessions, "Session")}` : "",
        ].filter(Boolean);
        out(`  ${c.name}  (needs ${needs.join(" and ")})\n`);
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

/** The conventional exit code for a command stopped by SIGINT. */
const interruptedExitCode = 130;

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function dollars(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function unpricedHint(models: string[], configFile: string): string {
  const example = JSON.stringify({ prices: { [models[0]!]: { inputPerMillion: 1, outputPerMillion: 5 } } });
  return `  sessionlore does not know the price of ${models.join(", ")}. To see costs, add US dollars per million tokens to ${configFile}:\n    ${example}\n`;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

function usage(): string {
  const lines = Object.entries(commands).map(([name, c]) => `  ${name.padEnd(10)} ${c.summary}`);
  return (
    `Usage: sessionlore <command> [--json]\n\nCommands:\n${lines.join("\n")}\n\n` +
    `Options:\n  --json                     Machine-readable output\n` +
    `  --last N                   scan: read only the N most recent Sessions\n` +
    `  --yes, -y                  analyze: skip the cost estimate confirmation\n` +
    `  --show-redacted <session>  analyze: print the redacted text Analysis would send for a Session\n`
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
        yes: { type: "boolean", short: "y", default: false },
        help: { type: "boolean", short: "h" },
        "show-redacted": { type: "string" },
        last: { type: "string" },
      },
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
    const modelProvider: ModelProviderResolution = io.modelProvider
      ? { ok: true, modelProvider: io.modelProvider }
      : resolveModelProvider(config.modelProvider, io.env, configPath(io.homeDir));
    app = App.open({
      storePath: storePath(io.homeDir),
      harnessContext: { homeDir: io.homeDir, env: io.env },
      adapters: io.adapters ?? allAdapters,
      clock: io.clock,
      modelProvider: modelProvider.ok ? modelProvider.modelProvider : undefined,
      embedder: io.embedder,
      projectFilter: config.projects,
      repeatRule: config.repeatRule,
      prices: config.prices,
    });
    const exitCode = await command.run({
      app,
      json: parsed.values.json ?? false,
      yes: parsed.values.yes ?? false,
      ask: io.ask,
      signal: io.signal,
      args: parsed.positionals.slice(1),
      options: { showRedacted: parsed.values["show-redacted"] },
      modelProvider,
      configFile: configPath(io.homeDir),
      last,
      out: io.stdout,
      err: io.stderr,
      warn: io.stderr,
    });
    return exitCode ?? 0;
  } catch (error) {
    io.stderr(`sessionlore ${name} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    app?.close();
  }
}
