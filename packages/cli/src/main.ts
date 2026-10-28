import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { allAdapters } from "@sessionlore/adapters";
import { allRenderers } from "@sessionlore/renderers";
import {
  App,
  type AnalysisEstimate,
  type AnalysisResult,
  type ScanResult,
  type SuggestResult,
  configPath,
  dataDir,
  loadConfig,
  storePath,
  type Suggestion,
  type Adapter,
  type Clock,
  type Embedder,
  type Env,
  type HarnessId,
  type ModelUsage,
  type Progress,
  type ModelProvider,
  type Renderer,
  type Scope,
  wholeNumber,
} from "@sessionlore/core";
import { createServer, listen } from "@sessionlore/server";
import { resolveModelProvider, type ModelProviderResolution } from "./model-provider.js";
import { openDemo } from "./demo.js";
import { openInEditor } from "./editor.js";
import { unsupportedNodeMessage } from "./node-version.js";
import { parseSince, sinceHelp } from "./since.js";

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
  /** `--since`: limit a Scan to Sessions active from this moment on. */
  since?: Date;
  /** The limits on a Scan as the person gave them, for telling them what was read. */
  scanWindow: ScanWindow;
  /** The person's home folder, shortened to `~` in paths shown to them. */
  homeDir: string;
  serve: { port: number; open: boolean; openBrowser?: (url: string) => void; uiDir?: string };
  out(text: string): void;
  err(text: string): void;
}

/** The limits on a Scan as given on the command line: `--since` as typed, `--last`, and the `--harness` names. */
interface ScanWindow {
  since?: string;
  last?: number;
  harnesses?: string[];
}

/** How far back `run` (and bare `sessionlore`) scans unless `--since` says otherwise. */
const DEFAULT_RUN_WINDOW = "30d";

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
        parts: [{ headline: analysisHeadline(estimate), models: estimate.models }],
        what: "Analysis",
        command: "analyze",
        declined: "Nothing analyzed.",
      });
      if (go !== true) return go;
      const result = await app.analyze({ signal, onProgress: progressLine(ctx) });
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
    async run({ app, json, last, harnesses, since, scanWindow, homeDir, out, warn }) {
      const result = await app.scan({ last, harnesses, since });
      if (json) {
        reportScan(result, scanWindow, homeDir, () => {}, warn);
        return out(JSON.stringify(result, null, 2) + "\n");
      }
      reportScan(result, scanWindow, homeDir, out, warn);
    },
  },
  run: {
    summary: `Scan (the last ${DEFAULT_RUN_WINDOW} by default), analyze and suggest in one go, then open the dashboard's Home; the default command`,
    async run(ctx) {
      const { app, json, signal, modelProvider, last, harnesses, since, scanWindow, homeDir, serve, out, err, warn } = ctx;
      const say = json ? err : out;
      const scanned = await app.scan({ last, harnesses, since });
      reportScan(scanned, scanWindow, homeDir, say, warn);
      if (!modelProvider.ok) {
        err(modelProvider.problem);
        return 1;
      }

      say("\n");
      const estimate = await app.estimateRun();
      const toAnalyze = estimate.analysis.sessions;
      const toSuggest = estimate.suggestions.suggestions;
      let analysis: AnalysisResult | null = null;
      let suggested: SuggestResult | null = null;
      if (toAnalyze === 0 && toSuggest === 0) {
        say("Nothing new to analyze and nothing to suggest.\n");
      } else {
        const parts = [];
        if (toAnalyze > 0) parts.push({ headline: analysisHeadline(estimate.analysis), models: estimate.analysis.models });
        if (toSuggest > 0) {
          parts.push(
            toAnalyze > 0
              ? {
                  headline: `Suggestions: one per Workflow or repeated Correction found, at most ${toSuggest}${perSuggestion(estimate.suggestions)}`,
                  models: estimate.suggestions.models,
                  atMost: true,
                }
              : { headline: `Suggestions: ${toSuggest} to write`, models: estimate.suggestions.models },
          );
        }
        const go = await confirmSpend(ctx, { parts, what: "Analysis", command: "run", declined: "Nothing analyzed." });
        if (go !== true) return go;
        if (toAnalyze > 0) {
          analysis = await app.analyze({ signal, onProgress: progressLine(ctx) });
          if (analysis.interrupted) {
            say(
              `Interrupted. ${analysis.analyzed.length} ${plural(analysis.analyzed.length, "Session")} analyzed and kept, ` +
                `${analysis.remaining} left; run \`sessionlore run\` again to pick up where this stopped.\n`,
            );
            reportUsage(say, analysis.usage);
            return interruptedExitCode;
          }
        }
        suggested = await app.suggest({ signal, onProgress: progressLine(ctx) });
        if (signal?.aborted) {
          say(`Interrupted. ${suggested.created.length} ${plural(suggested.created.length, "Suggestion")} written and kept.\n`);
          reportUsage(say, totalUsage(analysis?.usage ?? [], suggested.usage));
          return interruptedExitCode;
        }
      }

      const workflows = app.listWorkflows();
      const corrections = app.listCorrections();
      const found = {
        sessions: {
          added: scanned.harnesses.reduce((n, h) => n + h.added, 0),
          updated: scanned.harnesses.reduce((n, h) => n + h.updated, 0),
        },
        tasks: app.overview().counts.tasks,
        workflows: workflows.workflows.length,
        nearWorkflows: workflows.nearWorkflows.length,
        correctionClusters: corrections.correctionClusters.length,
        suggestionsWritten: suggested?.created.length ?? 0,
      };
      const usage = totalUsage(analysis?.usage ?? [], suggested?.usage ?? []);
      const pending = app.listSuggestions("Pending").length;
      if (!json) {
        const { minMembers, minSessions, windowDays } = workflows.repeatRule;
        const analyzedSessions = app.listTasks().length;
        out("\nFound in your analyzed Sessions\n");
        out(`  ${count(found.tasks)} ${plural(found.tasks, "Task")} across ${count(analyzedSessions)} ${plural(analyzedSessions, "Session")}\n`);
        out(
          `  ${count(found.workflows)} ${plural(found.workflows, "Workflow")} ` +
            `(similar Tasks done at least ${minMembers} ${plural(minMembers, "time")} in at least ${minSessions} ${plural(minSessions, "Session")} ` +
            `within ${windowDays} ${plural(windowDays, "day")}), ${count(found.nearWorkflows)} close to repeating\n`,
        );
        out(`  ${count(found.correctionClusters)} repeated ${plural(found.correctionClusters, "Correction")}\n`);
        const near = found.nearWorkflows + corrections.nearCorrectionClusters.length;
        out(`  ${suggestionsFound(found.suggestionsWritten, pending, found.workflows + found.correctionClusters, near, suggested, scanWindow)}\n`);
        for (const f of analysis?.failed ?? []) out(`  Session ${f.session} failed: ${f.error}\n`);
        for (const f of suggested?.failed ?? []) out(`  ${failedSource(f)} failed: ${f.error}\n`);
        reportUsage(out, usage);
        out("\n");
      }
      await serveDashboard(
        app,
        serve,
        signal,
        (url) =>
          json
            ? out(JSON.stringify({ url, scan: scanned, analysis, suggestions: suggested, found, usage }, null, 2) + "\n")
            : out(pending > 0 ? `Review ${pending === 1 ? "it" : "them"} on Home: ${url}\n` : `Open Home in your browser: ${url}\n`),
        say,
      );
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
      const id = wholeNumber(args[0]);
      if (id === null) throw new Error("Which Workflow? Usage: sessionlore workflow <id>");
      const workflow = app.getWorkflow(id);
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
          parts: [{ headline: `${estimate.clusters} new ${plural(estimate.clusters, "Cluster")} to name`, models: estimate.models }],
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
        parts: [{ headline: `Suggestions: ${estimate.suggestions} to write`, models: estimate.models }],
        what: "Writing Suggestions",
        command: "suggest",
        declined: "Nothing written.",
      });
      if (go !== true) return go;
      const result = await app.suggest({ signal, onProgress: progressLine(ctx) });
      if (json) return out(JSON.stringify(result, null, 2) + "\n");
      out(`${result.created.length} ${plural(result.created.length, "Suggestion")} written\n`);
      for (const f of result.failed) out(`  ${failedSource(f)} failed: ${f.error}\n`);
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
        (url) => (json ? out(JSON.stringify({ url }, null, 2) + "\n") : out(`Open Home in your browser: ${url}\n`)),
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
  // Home, the dashboard's root.
  const url = new URL("/", server.url).href;
  announce(url);
  say("Press Ctrl-C to stop the dashboard.\n");
  if (serve.open) serve.openBrowser?.(url);
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
  return app.reviewSuggestion(suggestion.id)?.changes?.map((c) => c.diff).join("") ?? null;
}

function indent(text: string, prefix: string): string {
  return text.replace(/^(?=.)/gm, prefix);
}

function suggestionId(args: string[], command: string): number {
  const id = wholeNumber(args[0]);
  if (id === null) {
    throw new Error(`Which Suggestion? Usage: sessionlore ${command} <id>. Run \`sessionlore review\` to list them.`);
  }
  return id;
}

/** The conventional exit code for a command stopped by SIGINT. */
const interruptedExitCode = 130;

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * What `run` did about Suggestions: how many it wrote, or why it wrote none,
 * and how many earlier ones still wait for review.
 */
function suggestionsFound(
  written: number,
  pending: number,
  sources: number,
  near: number,
  suggested: SuggestResult | null,
  window: ScanWindow,
): string {
  const earlier = pending - written;
  const waiting = earlier > 0 ? `, plus ${count(earlier)} from earlier still waiting` : "";
  if (written > 0) return `${count(written)} new ${plural(written, "Suggestion")} to review${waiting}`;
  let why: string;
  if (sources === 0) {
    const close = near > 0 ? ` (${count(near)} ${near === 1 ? "is" : "are"} close)` : "";
    const days = /^(\d+)([dw])$/.exec(window.since ?? "");
    const longer = days && Number(days[1]) * (days[2] === "w" ? 7 : 1) < 90 ? "--since 90d" : "a longer --since";
    why = `no Workflow or Correction repeats often enough yet${close}; scan more history with ${longer}`;
  } else if ((suggested?.failed.length ?? 0) > 0) {
    why = "writing them failed";
  } else {
    why = "every Workflow and repeated Correction already has one";
  }
  return `No new Suggestions: ${why}${waiting}`;
}

/** "Analysis: 3 new or changed Sessions (27 already analyzed, not charged again)". */
function analysisHeadline({ sessions, alreadyAnalyzed }: AnalysisEstimate): string {
  const already = alreadyAnalyzed > 0 ? ` (${count(alreadyAnalyzed)} already analyzed, not charged again)` : "";
  return `Analysis: ${count(sessions)} new or changed ${plural(sessions, "Session")}${already}`;
}

/** A cost in US dollars; one under a cent reads "less than $0.01", never "$0.00". */
function money(usd: number): string {
  if (usd === 0) return "$0";
  return usd < 0.01 ? "less than $0.01" : `$${usd.toFixed(2)}`;
}

/**
 * Shows what a command expects to spend and, unless `--yes`, asks to go ahead.
 * With `--json`, stdout carries only the result, so the estimate and question
 * go to stderr. Resolves to true to go ahead, or the exit code to stop with.
 */
async function confirmSpend(
  { json, yes, ask, configFile, out, err }: CommandContext,
  estimate: {
    /** Each part of the spend, in the order it happens; `atMost` labels an upper bound. */
    parts: { headline: string; models: ModelUsage[]; atMost?: boolean }[];
    what: string;
    command: string;
    declined: string;
  },
): Promise<true | number | undefined> {
  const say = json ? err : out;
  const rows = estimate.parts.map((part) =>
    part.models.map(({ model, tokens, costUsd }) => {
      const bound = part.atMost ? "at most" : "about";
      const cost = costUsd === null ? "cost unknown" : costUsd < 0.01 ? money(costUsd) : `${bound} ${money(costUsd)}`;
      return [model, `${bound} ${count(tokens.input)} input + ${count(tokens.output)} output tokens`, cost];
    }),
  );
  estimate.parts.forEach((part, i) => {
    say(`${part.headline}\n`);
    say(table(rows[i]!, rows.flat()));
  });
  const unpriced = [...new Set(estimate.parts.flatMap((p) => p.models).filter((m) => m.costUsd === null).map((m) => m.model))];
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

/** What a Scan read, per Harness, with any warnings. */
const SEE_HELP = "Run `sessionlore --help` for every command and option.\n";

/**
 * Shows how far an Analysis or Suggestion run has got, on one stderr line that
 * rewrites itself. Only in a terminal: piped and `--json` output stay clean.
 */
function progressLine({ ask, err }: CommandContext): ((progress: Progress) => void) | undefined {
  if (!ask) return undefined;
  return (progress) => {
    if (progress.step === "grouping") return err("Grouping similar Tasks and Corrections…\n");
    const noun = progress.step === "sessions" ? "Session" : "Suggestion";
    const verb = progress.step === "sessions" ? "Analyzed" : "Wrote";
    const end = progress.done === progress.total ? "\n" : "";
    err(`\r${verb} ${progress.done} of ${progress.total} ${plural(progress.total, noun)}${end}`);
  };
}

function reportScan(
  result: ScanResult,
  window: ScanWindow,
  homeDir: string,
  out: (text: string) => void,
  warn: (text: string) => void,
): void {
  if (result.harnesses.length === 0) {
    out("No Claude Code or Cursor Sessions found on this machine.\n");
    return;
  }
  for (const warning of result.harnesses.flatMap((h) => h.warnings)) warn(`Warning: ${warning}\n`);
  out(`Reading ${scanWhat(window)} (read-only)\n`);
  out(
    table(
      result.harnesses.map((h) => [
        h.name,
        h.locations.map((l) => tildify(l, homeDir)).join(", "),
        scanCounts(h.added, h.updated, h.unchanged),
      ]),
    ),
  );
}

/** "your Sessions from the last 30 days", naming the limits `--since`, `--last` and `--harness` put on a Scan. */
function scanWhat({ since, last, harnesses }: ScanWindow): string {
  const yours = harnesses ? `your ${harnesses.join(" and ")} Sessions` : "your Sessions";
  const which = last === undefined ? (since === undefined ? `all ${yours}` : yours) : last === 1 ? `the most recent of ${yours}` : `the ${count(last)} most recent of ${yours}`;
  if (since === undefined) return which;
  const relative = /^(\d+)([dw])$/.exec(since);
  if (!relative) return `${which} active since ${since}`;
  const n = Number(relative[1]);
  const unit = relative[2] === "w" ? "week" : "day";
  return `${which} from the last ${n === 1 ? unit : `${n} ${unit}s`}`;
}

/** "10 Sessions, 2 new, 1 changed since the last run", or "…, nothing new". */
function scanCounts(added: number, updated: number, unchanged: number): string {
  const total = added + updated + unchanged;
  const changes = [added > 0 && `${count(added)} new`, updated > 0 && `${count(updated)} changed since the last run`].filter(Boolean);
  return `${count(total)} ${plural(total, "Session")}, ${changes.length > 0 ? changes.join(", ") : "nothing new"}`;
}

/** `path` with the home folder shortened to `~`. */
function tildify(path: string, homeDir: string): string {
  return path === homeDir || path.startsWith(homeDir + sep) ? `~${path.slice(homeDir.length)}` : path;
}

/** Rows as indented columns, each padded to its widest cell in `aligned` (by default, the rows themselves). */
function table(rows: string[][], aligned: string[][] = rows): string {
  if (rows.length === 0) return "";
  const widths = rows[0]!.map((_, i) => Math.max(...aligned.map((r) => r[i]!.length)));
  return rows.map((r) => `  ${r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ")}\n`).join("");
}

/** Usage of several steps added up per model; a cost is unknown when any step's is. */
function totalUsage(...steps: (readonly ModelUsage[])[]): ModelUsage[] {
  const total = new Map<string, ModelUsage>();
  for (const u of steps.flat()) {
    const sum = total.get(u.model);
    total.set(
      u.model,
      sum
        ? {
            model: u.model,
            tokens: { input: sum.tokens.input + u.tokens.input, output: sum.tokens.output + u.tokens.output },
            costUsd: sum.costUsd === null || u.costUsd === null ? null : sum.costUsd + u.costUsd,
          }
        : u,
    );
  }
  return [...total.values()];
}

function failedSource(f: SuggestResult["failed"][number]): string {
  return "workflow" in f ? `Workflow ${f.workflow}` : `Correction Cluster ${f.correctionCluster}`;
}

/** The tokens and cost a command actually used, per model. */
/** ", about $0.004 each" when every model's price is known, so the upper bound reads as a ceiling, not a forecast. */
function perSuggestion({ suggestions, models }: { suggestions: number; models: ModelUsage[] }): string {
  if (suggestions === 0 || models.some((m) => m.costUsd === null)) return "";
  const each = models.reduce((sum, m) => sum + m.costUsd!, 0) / suggestions;
  if (each < 0.001) return ", less than $0.001 each";
  return `, about $${each < 0.01 ? each.toFixed(3) : each.toFixed(2)} each`;
}

/** The total cost a command ran up, then the tokens and cost of each model. */
function reportUsage(out: (text: string) => void, usage: readonly ModelUsage[]): void {
  if (usage.length === 0) return;
  const known = usage.reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
  const unpriced = usage.filter((u) => u.costUsd === null).map((u) => u.model);
  const total =
    unpriced.length === usage.length
      ? "unknown"
      : unpriced.length > 0
        ? `${money(known)}, plus ${unpriced.join(" and ")} at an unknown price`
        : money(known);
  out(`Cost: ${total}\n`);
  out(
    table(
      usage.map(({ model, tokens, costUsd }) => [
        model,
        `${count(tokens.input)} input + ${count(tokens.output)} output tokens`,
        costUsd === null ? "cost unknown" : money(costUsd),
      ]),
    ),
  );
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
    `Usage: sessionlore <command> [--json]\n\nWith no command, sessionlore does \`run\` with its defaults.\n\nCommands:\n${lines.join("\n")}\n\n` +
    `Options:\n  --json                     Machine-readable output\n` +
    `  --last N                   scan, run: read only the N most recent Sessions\n` +
    `  --since <window>           scan, run: read only Sessions active within 30d, 2w, or since a date (2026-09-01)\n` +
    `  --harness <id>             scan, run: read only claude-code or cursor (repeat, or separate with commas)\n` +
    `  --yes, -y                  run, analyze, suggest, recluster: skip the cost estimate confirmation\n` +
    `  --show-redacted <session>  analyze: print the redacted text Analysis would send for a Session\n` +
    `  --export                   stats: print aggregate numbers only (counts, Corrections per Task, Workflow names)\n` +
    `  --anonymize                stats --export: replace Workflow names with neutral labels\n` +
    `  --port N                   run, serve, demo: port to serve the dashboard on (default ${DEFAULT_PORT})\n` +
    `  --no-open                  run, serve, demo: print the dashboard's address without opening the browser\n`
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
        since: { type: "string" },
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

  // Bare `sessionlore` runs the whole flow.
  const name = parsed.positionals[0] ?? "run";
  if (parsed.values.help) {
    io.stdout(usage());
    return 0;
  }
  const command = commands[name];
  const standalone = standaloneCommands[name];
  if (!command && !standalone) {
    io.stderr(`Unknown command: ${name}\n\n${usage()}`);
    return 2;
  }

  let last: number | undefined;
  if (parsed.values.last !== undefined) {
    last = wholeNumber(parsed.values.last) ?? 0;
    if (last < 1) {
      io.stderr(`--last takes a positive whole number of Sessions, not "${parsed.values.last}"\n${SEE_HELP}`);
      return 2;
    }
  }

  const window = parsed.values.since ?? (name === "run" ? DEFAULT_RUN_WINDOW : undefined);
  let since: Date | undefined;
  if (window !== undefined) {
    since = parseSince(window, io.clock.now()) ?? undefined;
    if (!since) {
      io.stderr(`--since takes ${sinceHelp}, not "${window}"\n${SEE_HELP}`);
      return 2;
    }
  }

  let harnesses: HarnessId[] | undefined;
  if (parsed.values.harness !== undefined) {
    const known = (io.adapters ?? allAdapters).map((a) => a.harness);
    const named = parsed.values.harness.flatMap((h) => h.split(",")).map((h) => h.trim()).filter(Boolean);
    const unknown = named.filter((h) => !known.includes(h as HarnessId));
    if (named.length === 0 || unknown.length > 0) {
      io.stderr(`--harness takes ${known.join(" or ")} (repeat it or separate them with commas), not "${unknown.join(", ")}"\n${SEE_HELP}`);
      return 2;
    }
    harnesses = named as HarnessId[];
  }

  let port = DEFAULT_PORT;
  if (parsed.values.port !== undefined) {
    port = wholeNumber(parsed.values.port) ?? -1;
    if (port < 0 || port > 65535) {
      io.stderr(`--port takes a port number from 0 to 65535, not "${parsed.values.port}"\n${SEE_HELP}`);
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
      since,
      scanWindow: {
        since: window,
        last,
        harnesses: harnesses?.map((h) => (io.adapters ?? allAdapters).find((a) => a.harness === h)!.displayName),
      },
      homeDir: io.homeDir,
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
