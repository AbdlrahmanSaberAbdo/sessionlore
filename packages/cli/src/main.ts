import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { allAdapters } from "@sessionlore/adapters";
import { allRenderers } from "@sessionlore/renderers";
import {
  App,
  configPath,
  dataDir,
  loadConfig,
  RenderError,
  storePath,
  type Suggestion,
  type Adapter,
  type Clock,
  type Embedder,
  type Env,
  type HarnessId,
  type ModelUsage,
  type ModelProvider,
  type Renderer,
  type Scope,
} from "@sessionlore/core";
import { createServer, listen } from "@sessionlore/server";
import { resolveModelProvider, type ModelProviderResolution } from "./model-provider.js";
import { openDemo } from "./demo.js";
import { openInEditor } from "./editor.js";
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
  /** Opens a URL in the person's browser; `serve` only prints the address without it. */
  openBrowser?: (url: string) => void;
  /** Folder of the built dashboard UI that `serve` ships. */
  uiDir?: string;
  /** Defaults to every Renderer sessionlore ships. */
  renderers?: readonly Renderer[];
  /** Opens a file in the person's editor and resolves once they close it. Defaults to $VISUAL or $EDITOR. */
  editFile?: (path: string) => Promise<void>;
  /** Folder `demo` creates its throwaway home directory in. Defaults to the system's temp folder. */
  demoRoot?: string;
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
  options: { showRedacted?: string; export: boolean; anonymize: boolean };
  modelProvider: ModelProviderResolution;
  /** Path of the config file, for messages that tell the person what to set. */
  configFile: string;
  warn(text: string): void;
  /** Opens a file in the person's editor and resolves once they close it. */
  editFile(path: string): Promise<void>;
  /** sessionlore's data folder, for scratch files such as one being edited. */
  dataDir: string;
  /** `--last N`: limit a Scan to the N most recent Sessions. */
  last?: number;
  /** `--harness`: limit a Scan to these Harnesses. */
  harnesses?: HarnessId[];
  serve: { port: number; open: boolean; openBrowser?: (url: string) => void; uiDir?: string };
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
    async run(ctx) {
      const { app, json, signal, options, modelProvider, out, err } = ctx;
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
      if (estimate.sessions === 0) {
        (json ? err : out)("No new or changed Sessions to analyze.\n");
        if (json) out(JSON.stringify(await app.analyze(), null, 2) + "\n");
        return;
      }
      const go = await confirmSpend(ctx, {
        headline: `${estimate.sessions} ${plural(estimate.sessions, "Session")} to analyze`,
        models: estimate.models,
        what: "Analysis",
        command: "analyze",
        declined: "Nothing analyzed.",
      });
      if (go !== true) return go;
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
      reportUsage(out, result.usage);
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
    async run({ app, json, last, harnesses, out, warn }) {
      const result = await app.scan({ last, harnesses });
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
      for (const w of result.nearWorkflows) out(`  ${w.name}  (needs ${needsText([w.needs.tasks, "Task"], [w.needs.sessions, "Session"])})\n`);
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
    async run(ctx) {
      const { app, json, signal, out } = ctx;
      const estimate = await app.estimateRecluster();
      if (estimate.clusters > 0) {
        const go = await confirmSpend(ctx, {
          headline: `${estimate.clusters} new ${plural(estimate.clusters, "Cluster")} to name`,
          models: estimate.models,
          what: "Re-clustering",
          command: "recluster",
          declined: "Nothing re-clustered.",
        });
        if (go !== true) return go;
      }
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
      reportUsage(out, result.usage);
    },
  },
  suggest: {
    summary: "Write Suggestions with the strong model: a Skill for each Workflow and a Rule for each Correction Cluster that has none",
    async run(ctx) {
      const { app, json, signal, modelProvider, out, err } = ctx;
      if (!modelProvider.ok) {
        err(modelProvider.problem);
        return 1;
      }
      const estimate = await app.estimateSuggestions();
      if (estimate.suggestions === 0) {
        (json ? err : out)("No Workflow or Correction Cluster needs a Suggestion.\n");
        if (json) out(JSON.stringify(await app.suggest(), null, 2) + "\n");
        return;
      }
      const go = await confirmSpend(ctx, {
        headline: `${estimate.suggestions} ${plural(estimate.suggestions, "Suggestion")} to write`,
        models: estimate.models,
        what: "Writing Suggestions",
        command: "suggest",
        declined: "Nothing written.",
      });
      if (go !== true) return go;
      const result = await app.suggest({ signal });
      if (json) return out(JSON.stringify(result, null, 2) + "\n");
      out(`${result.created.length} ${plural(result.created.length, "Suggestion")} written\n`);
      for (const f of result.failed) {
        out(`  ${"workflow" in f ? `Workflow ${f.workflow}` : `Correction Cluster ${f.correctionCluster}`} failed: ${f.error}\n`);
      }
      reportUsage(out, result.usage);
      if (result.created.length > 0) out("Run `sessionlore review` to see them.\n");
    },
  },
  review: {
    summary: "List Pending Suggestions with their Evidence, and a diff for those that update an existing Skill or Rule",
    run({ app, json, out }) {
      const suggestions = app.listSuggestions("Pending").map((s) => ({ ...s, diff: targetDiff(app, s) }));
      if (json) return out(JSON.stringify({ suggestions }, null, 2) + "\n");
      if (suggestions.length === 0) return out("No Pending Suggestions. Run `sessionlore suggest` to write some.\n");
      for (const s of suggestions) {
        const scope = scopeLabel(s.scope);
        out(`#${s.id}  ${s.kind === "skill" ? "Skill" : "Rule"}: ${s.title}  [${scope}]\n`);
        if (s.target) {
          out(`  Updates ${s.target.path}\n`);
          out(s.diff === null ? "  (the change can't be shown: accepting it would fail)\n" : indent(s.diff, "    "));
        } else if (s.kind === "skill") {
          if (s.companionOf) out(`  Complements the plugin skill ${s.companionOf.plugin}:${s.companionOf.name}\n`);
          out(`  When: ${s.trigger}\n`);
          s.steps.forEach((step, i) => out(`  ${i + 1}. ${step}\n`));
        } else {
          out(`  Rule: ${s.rule}\n`);
        }
        out(`  Evidence:\n`);
        for (const e of s.evidence) {
          const what = e.correction ? `"${e.correction.text}" in ${e.task.title}` : e.task.title;
          out(`    ${(e.correction?.at ?? e.task.at).slice(0, 10)}  ${what}  (Session ${e.session.id})\n`);
        }
        out("\n");
      }
      out("Accept with `sessionlore accept <id>`, or reject with `sessionlore reject <id>`. Change one first with `sessionlore edit <id>` or `sessionlore scope <id> user|project`.\n");
    },
  },
  accept: {
    summary: "Install a Pending Suggestion where its Scope says: accept <id>",
    run({ app, json, args, out }) {
      const result = app.acceptSuggestion(suggestionId(args, "accept"));
      if (json) return out(JSON.stringify(result, null, 2) + "\n");
      out(`Accepted #${result.suggestion.id} ${result.suggestion.title}. Wrote:\n`);
      for (const file of result.files) out(`  ${file.path}\n`);
      if (result.backups.length > 0) {
        out(`Backed up the previous ${plural(result.backups.length, "version")}; undo with \`sessionlore restore ${result.suggestion.id}\`.\n`);
      }
    },
  },
  restore: {
    summary: "Put back the files an Accepted Suggestion overwrote: restore <id>",
    run({ app, json, args, out }) {
      const result = app.restoreSuggestion(suggestionId(args, "restore"));
      if (json) return out(JSON.stringify(result, null, 2) + "\n");
      out(`Restored the files #${result.suggestion.id} ${result.suggestion.title} overwrote:\n`);
      for (const path of result.files) out(`  ${path}\n`);
    },
  },
  reject: {
    summary: "Reject a Pending Suggestion so it isn't proposed again: reject <id>",
    run({ app, json, args, out }) {
      const suggestion = app.rejectSuggestion(suggestionId(args, "reject"));
      if (json) return out(JSON.stringify({ suggestion }, null, 2) + "\n");
      out(`Rejected #${suggestion.id} ${suggestion.title}.\n`);
    },
  },
  edit: {
    summary: "Edit a Pending Suggestion in your editor before accepting it: edit <id>",
    async run({ app, json, args, editFile, dataDir, out, err }) {
      const id = suggestionId(args, "edit");
      const form = app.suggestionForm(id);
      mkdirSync(dataDir, { recursive: true });
      const file = join(dataDir, `suggestion-${id}.json`);
      writeFileSync(file, JSON.stringify(form, null, 2) + "\n");
      try {
        await editFile(file);
        let edited: unknown;
        try {
          edited = JSON.parse(readFileSync(file, "utf8"));
        } catch (error) {
          err(`The edited Suggestion is not valid JSON (${(error as Error).message}); nothing was saved.\n`);
          return 1;
        }
        const suggestion = app.editSuggestion(id, edited);
        if (json) return out(JSON.stringify({ suggestion }, null, 2) + "\n");
        out(`Saved #${suggestion.id} ${suggestion.title}.\n`);
      } finally {
        rmSync(file, { force: true });
      }
    },
  },
  scope: {
    summary: "Change where a Pending Suggestion installs: scope <id> user | scope <id> project [folder]",
    run({ app, json, args, out }) {
      const id = suggestionId(args, "scope");
      const [, kind, folder] = args;
      if (kind !== "user" && kind !== "project") {
        throw new Error("Which Scope? Usage: sessionlore scope <id> user, or sessionlore scope <id> project [folder]");
      }
      const result = app.setScope(id, kind === "user" ? { kind } : { kind, folder: folder && resolve(folder) });
      if (json) return out(JSON.stringify(result, null, 2) + "\n");
      const { suggestion, droppedTarget } = result;
      out(`#${suggestion.id} ${suggestion.title} will install in ${scopeLabel(suggestion.scope)}.\n`);
      if (droppedTarget) {
        const what = suggestion.kind === "skill" ? "a new Skill" : "a new Rule";
        out(`It no longer updates ${droppedTarget.path}, which is outside that Scope; accepting it adds ${what} there instead.\n`);
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
        out(`  ${c.name}  (needs ${needsText([c.needs.corrections, "Correction"], [c.needs.sessions, "Session"])})\n`);
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
  serve: {
    summary: "Open the dashboard in your browser, served on localhost only",
    async run({ app, json, serve, signal, out, err }) {
      await serveDashboard(
        app,
        serve,
        signal,
        (url) => (json ? out(JSON.stringify({ url }, null, 2) + "\n") : out(`sessionlore dashboard: ${url}\n`)),
        json ? err : out,
      );
    },
  },
  stats: {
    summary: "Show how often Accepted Skills are used; --export prints shareable aggregate numbers as JSON",
    run({ app, json, options, out }) {
      if (options.export) return out(JSON.stringify(app.exportStats({ anonymize: options.anonymize }), null, 2) + "\n");
      const result = app.stats();
      if (json) return out(JSON.stringify(result, null, 2) + "\n");
      if (result.skills.length === 0) out("No Accepted Skills yet.\n");
      for (const s of result.skills) {
        const last = s.lastUsedAt ? `, last on ${s.lastUsedAt.slice(0, 10)}` : "";
        out(`#${s.suggestion} ${s.title}: used ${s.uses} ${plural(s.uses, "time")} since ${s.acceptedAt.slice(0, 10)}${last}\n`);
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

interface StandaloneContext {
  clock: Clock;
  json: boolean;
  /** Folder `demo` creates its throwaway home directory in. */
  demoRoot: string;
  signal?: AbortSignal;
  serve: CommandContext["serve"];
  out(text: string): void;
  err(text: string): void;
}

/** Commands that never open the person's own store or config. */
const standaloneCommands: Record<string, { summary: string; run(ctx: StandaloneContext): Promise<void> }> = {
  demo: {
    summary: "Open the dashboard on a made-up history; needs no Model Provider and never touches your own store",
    async run({ clock, demoRoot, json, signal, serve, out, err }) {
      const demo = await openDemo({ root: demoRoot, clock });
      try {
        await serveDashboard(
          demo.app,
          serve,
          signal,
          (url) =>
            json
              ? out(JSON.stringify({ url, dataset: demoSummary(demo.app) }, null, 2) + "\n")
              : out(`sessionlore demo dashboard (made-up Sessions, kept apart from your own): ${url}\n`),
          json ? err : out,
        );
      } finally {
        demo.close();
      }
    },
  },
};

function scopeLabel(scope: Scope): string {
  return scope.kind === "project" ? `Project scope (${scope.project.name})` : "User scope";
}

/**
 * Serves the dashboard for `app` until the person interrupts, announcing its
 * address with `announce` and how to stop it with `say`, and opening the browser unless told not to.
 */
async function serveDashboard(
  app: App,
  serve: CommandContext["serve"],
  signal: AbortSignal | undefined,
  announce: (url: string) => void,
  say: (text: string) => void,
): Promise<void> {
  const server = await listen(createServer({ app, uiDir: serve.uiDir }), { port: serve.port });
  announce(server.url);
  say("Press Ctrl-C to stop.\n");
  if (serve.open) serve.openBrowser?.(server.url);
  await stopped(signal);
  await server.close();
}

/** What the demo dataset holds, as `demo --json` reports it. */
function demoSummary(app: App) {
  const overview = app.overview();
  return {
    sessions: overview.counts.sessions,
    tasks: overview.counts.tasks,
    harnesses: [...new Set(app.listSessions().map((s) => s.harness))].sort(),
    workflows: overview.counts.workflows,
    nearWorkflows: app.listWorkflows().nearWorkflows.length,
    correctionClusters: app.listCorrections().correctionClusters.length,
    pendingSuggestions: app.listSuggestions("Pending").length,
  };
}

/** Resolves once the person interrupts (Ctrl-C), at once if they already have. */
function stopped(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** The dashboard's port unless `--port` says otherwise; a free one is picked when it is taken. */
const DEFAULT_PORT = 4848;

/** The diff accepting a Suggestion with a Target would make; null without a Target or when it can't be rendered. */
function targetDiff(app: App, suggestion: Suggestion): string | null {
  if (!suggestion.target) return null;
  try {
    return app
      .suggestionChanges(suggestion.id)
      .map((c) => c.diff)
      .join("");
  } catch (error) {
    if (error instanceof RenderError) return null;
    throw error;
  }
}

function indent(text: string, prefix: string): string {
  return text.replace(/^(?=.)/gm, prefix);
}

function suggestionId(args: string[], command: string): number {
  const [id] = args;
  if (!id || !/^\d+$/.test(id)) {
    throw new Error(`Which Suggestion? Usage: sessionlore ${command} <id>. Run \`sessionlore review\` to list them.`);
  }
  return Number(id);
}

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

/**
 * Shows what a command expects to spend and, unless `--yes`, asks to go ahead.
 * With `--json`, stdout carries only the result, so the estimate and question
 * go to stderr. Resolves to true to go ahead, or the exit code to stop with.
 */
async function confirmSpend(
  { json, yes, ask, configFile, out, err }: CommandContext,
  estimate: { headline: string; models: ModelUsage[]; what: string; command: string; declined: string },
): Promise<true | number | undefined> {
  const say = json ? err : out;
  say(`${estimate.headline}. Estimated use:\n`);
  for (const { model, tokens, costUsd } of estimate.models) {
    const cost = costUsd === null ? "cost unknown" : `about ${dollars(costUsd)}`;
    say(`  ${model}: about ${count(tokens.input)} input and ${count(tokens.output)} output tokens, ${cost}\n`);
  }
  const unpriced = estimate.models.filter((m) => m.costUsd === null).map((m) => m.model);
  if (unpriced.length > 0) say(unpricedHint(unpriced, configFile));
  if (yes) return true;
  if (!ask) {
    err(`${estimate.what} needs confirmation before it calls the Model Provider. Run \`sessionlore ${estimate.command} --yes\` to go ahead.\n`);
    return 1;
  }
  const answer = await ask("Continue? [y/N] ");
  if (/^\s*y(es)?\s*$/i.test(answer)) return true;
  say(`${estimate.declined}\n`);
  return undefined;
}

/** The tokens and cost a command actually used, per model. */
function reportUsage(out: (text: string) => void, usage: readonly ModelUsage[]): void {
  for (const { model, tokens, costUsd } of usage) {
    const cost = costUsd === null ? "cost unknown" : dollars(costUsd);
    out(`Used: ${model}: ${count(tokens.input)} input and ${count(tokens.output)} output tokens, ${cost}\n`);
  }
}

/** "2 more Tasks and 1 more Session", leaving out what is not needed. */
function needsText(...needs: [number, string][]): string {
  return needs
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} more ${plural(n, word)}`)
    .join(" and ");
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
  const lines = Object.entries({ ...commands, ...standaloneCommands }).map(([name, c]) => `  ${name.padEnd(10)} ${c.summary}`);
  return (
    `Usage: sessionlore <command> [--json]\n\nCommands:\n${lines.join("\n")}\n\n` +
    `Options:\n  --json                     Machine-readable output\n` +
    `  --last N                   scan: read only the N most recent Sessions\n` +
    `  --harness <id>             scan: read only claude-code or cursor (repeat, or separate with commas)\n` +
    `  --yes, -y                  analyze, suggest, recluster: skip the cost estimate confirmation\n` +
    `  --show-redacted <session>  analyze: print the redacted text Analysis would send for a Session\n` +
    `  --export                   stats: print aggregate numbers only (counts, Corrections per Task, Workflow names)\n` +
    `  --anonymize                stats --export: replace Workflow names with neutral labels\n` +
    `  --port N                   serve, demo: port to serve the dashboard on (default ${DEFAULT_PORT})\n` +
    `  --no-open                  serve, demo: print the dashboard's address without opening the browser\n`
  );
}

/** What opening the App needs from the CLI's surroundings. */
export type AppEnvironment = Pick<CliEnvironment, "homeDir" | "env" | "clock" | "modelProvider" | "embedder" | "adapters" | "renderers">;

/**
 * Opens the App on the person's store and config file, wired the way every
 * command (and the dashboard server) uses it. Throws on an invalid config.
 */
export function openApp(io: AppEnvironment): App {
  return openConfiguredApp(io).app;
}

function openConfiguredApp(io: AppEnvironment): { app: App; modelProvider: ModelProviderResolution } {
  const config = loadConfig(io.homeDir);
  const modelProvider: ModelProviderResolution = io.modelProvider
    ? { ok: true, modelProvider: io.modelProvider }
    : resolveModelProvider(config.modelProvider, io.env, configPath(io.homeDir));
  const app = App.open({
    storePath: storePath(io.homeDir),
    harnessContext: { homeDir: io.homeDir, env: io.env },
    adapters: io.adapters ?? allAdapters,
    clock: io.clock,
    modelProvider: modelProvider.ok ? modelProvider.modelProvider : undefined,
    embedder: io.embedder,
    projectFilter: config.projects,
    repeatRule: config.repeatRule,
    prices: config.prices,
    renderers: io.renderers ?? allRenderers,
  });
  return { app, modelProvider };
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
        harness: { type: "string", multiple: true },
        export: { type: "boolean", default: false },
        anonymize: { type: "boolean", default: false },
        port: { type: "string" },
        "no-open": { type: "boolean", default: false },
      },
    });
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${usage()}`);
    return 2;
  }

  const [name] = parsed.positionals;
  if (parsed.values.help) {
    io.stdout(usage());
    return 0;
  }
  if (!name) {
    io.stderr(usage());
    return 2;
  }
  const command = commands[name];
  const standalone = standaloneCommands[name];
  if (!command && !standalone) {
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

  let harnesses: HarnessId[] | undefined;
  if (parsed.values.harness !== undefined) {
    const known = (io.adapters ?? allAdapters).map((a) => a.harness);
    const named = parsed.values.harness.flatMap((h) => h.split(",")).map((h) => h.trim()).filter(Boolean);
    const unknown = named.filter((h) => !known.includes(h as HarnessId));
    if (named.length === 0 || unknown.length > 0) {
      io.stderr(`--harness takes ${known.join(" or ")} (repeat it or separate them with commas), not "${unknown.join(", ")}"\n\n${usage()}`);
      return 2;
    }
    harnesses = named as HarnessId[];
  }

  let port = DEFAULT_PORT;
  if (parsed.values.port !== undefined) {
    port = /^\d+$/.test(parsed.values.port) ? Number(parsed.values.port) : -1;
    if (port < 0 || port > 65535) {
      io.stderr(`--port takes a port number from 0 to 65535, not "${parsed.values.port}"\n\n${usage()}`);
      return 2;
    }
  }

  const serve = { port, open: !parsed.values["no-open"], openBrowser: io.openBrowser, uiDir: io.uiDir };
  if (standalone) {
    try {
      await standalone.run({
        clock: io.clock,
        json: parsed.values.json ?? false,
        demoRoot: io.demoRoot ?? tmpdir(),
        signal: io.signal,
        serve,
        out: io.stdout,
        err: io.stderr,
      });
      return 0;
    } catch (error) {
      io.stderr(`sessionlore ${name} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  let app: App | undefined;
  try {
    const opened = openConfiguredApp(io);
    app = opened.app;
    const { modelProvider } = opened;
    const exitCode = await command!.run({
      app,
      json: parsed.values.json ?? false,
      yes: parsed.values.yes ?? false,
      ask: io.ask,
      signal: io.signal,
      args: parsed.positionals.slice(1),
      options: {
        showRedacted: parsed.values["show-redacted"],
        export: parsed.values.export ?? false,
        anonymize: parsed.values.anonymize ?? false,
      },
      modelProvider,
      configFile: configPath(io.homeDir),
      last,
      harnesses,
      editFile: io.editFile ?? ((path) => openInEditor(path, io.env)),
      dataDir: dataDir(io.homeDir),
      serve,
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
