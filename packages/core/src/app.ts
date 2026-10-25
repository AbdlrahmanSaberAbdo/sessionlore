import type { Adapter, HarnessContext, HarnessId, SessionSource } from "./adapter.js";
import type { Clock, Embedder, ModelProvider } from "./ports.js";
import { ProjectFilter } from "./project-filter.js";
import { resolveProject } from "./project.js";
import {
  applyRepeatRule,
  defaultRepeatRule,
  estimateTaskSplit,
  MalformedReplyError,
  nameCluster,
  nameCorrectionCluster,
  placeTasks,
  splitIntoTasks,
  succession,
  taskEmbeddingText,
  taskSplitPrompt,
  writeRule,
  writeSkill,
  type RepeatRule,
  type RepeatRuleResult,
  type TokenCount,
} from "@sessionlore/analysis";
import { correctionsPerWeek, TOP_WORKFLOWS, type Overview } from "./overview.js";
import {
  distinct,
  filterOptions,
  matchesFilter,
  type BrowseFilter,
  type MindMap,
  type MindMapEdge,
  type MindMapNode,
  type SessionList,
  type SessionView,
  type SessionViewMessage,
  type SuggestionRef,
  type WorkflowDetail,
  type WorkflowList,
  type WorkflowSummary,
} from "./browse.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { unifiedDiff } from "./diff.js";
import { Overlaps, withTarget } from "./targets.js";
import {
  defaultScope,
  evidenceFingerprint,
  regeneration,
  type Evidence,
  type InstalledContext,
  type ProjectRef,
  type Scope,
  type Target,
  type RenderContext,
  type RenderedFile,
  type Renderer,
  type SkillSuggestion,
  type Suggestion,
  type SuggestionState,
} from "./suggestion.js";
import { costUsd, type Prices } from "./pricing.js";
import { correctionsPerTask, type CorrectionsPerTask } from "./measuring.js";
import {
  Store,
  type ClusterCorrection,
  type ClusterKind,
  type ClusterTask,
  type PriorSuggestionRow,
  type SessionTasks,
  type StoredCluster,
  type StoredMessage,
  type StoredSession,
  type StoredSessionDetail,
} from "./store/store.js";

/**
 * The application interface. The CLI and the HTTP server are thin layers over
 * this; neither contains domain logic.
 */

export interface AppDependencies {
  /** Path of the store database file. */
  storePath: string;
  harnessContext: HarnessContext;
  adapters: readonly Adapter[];
  clock: Clock;
  modelProvider?: ModelProvider;
  /** Needed to cluster Tasks; without one, Analysis stops after splitting Sessions into Tasks. */
  embedder?: Embedder;
  /** Which Projects may be stored and shown. Defaults to all of them. */
  projectFilter?: ProjectFilter;
  /** Defaults to 3 Tasks across 2 Sessions within 60 days. */
  repeatRule?: RepeatRule;
  /** Model prices from the config, overriding the built-in ones. */
  prices?: Prices;
  /** Turn Accepted Suggestions into Harness files; at least one per kind of Suggestion that can be accepted. */
  renderers?: readonly Renderer[];
}

/** A Cluster as `workflows` shows it. Its id is stable across Analyses. */
export interface ClusterView {
  id: number;
  name: string;
  /** Every Task in the Cluster, oldest first, including those outside the Repeat Rule's window. */
  tasks: ClusterTask[];
  /** The distinct Sessions of those Tasks, in order of their first Task. */
  sessions: { id: string; harness: HarnessId; project: { name: string; path: string } | null }[];
  harnesses: HarnessId[];
  /** Tasks and Sessions inside the Repeat Rule's window, which is what the rule counts. */
  counted: { tasks: number; sessions: number };
  /** Over every Task in the Cluster, and per month the Tasks started in. */
  correctionsPerTask: CorrectionsPerTask;
}

/** A Correction Cluster as `corrections` shows it. Its id is stable across Analyses. */
export interface CorrectionClusterView {
  id: number;
  name: string;
  /** Every Correction in it, oldest first, including those outside the Repeat Rule's window. */
  corrections: ClusterCorrection[];
  /** The distinct Sessions of those Corrections, in order of their first Correction. */
  sessions: ClusterView["sessions"];
  harnesses: HarnessId[];
  /** Corrections and Sessions inside the Repeat Rule's window, which is what the rule counts. */
  counted: { corrections: number; sessions: number };
}

/** A Correction Cluster close to passing the Repeat Rule. */
export interface NearCorrectionClusterView extends CorrectionClusterView {
  /** How many more Corrections and Sessions inside the window it needs to pass. */
  needs: { corrections: number; sessions: number };
}

export interface CorrectionsResult {
  repeatRule: RepeatRule;
  /** Correction Clusters that pass the Repeat Rule. */
  correctionClusters: CorrectionClusterView[];
  nearCorrectionClusters: NearCorrectionClusterView[];
}

/** A Cluster close to passing the Repeat Rule. */
export interface NearWorkflowView extends ClusterView {
  /** How many more Tasks and Sessions inside the window it needs to become a Workflow. */
  needs: { tasks: number; sessions: number };
}

/** How often the agent has used an Accepted Skill since it was installed. */
export interface SkillUsage {
  /** The Accepted Suggestion's id. */
  suggestion: number;
  title: string;
  acceptedAt: string;
  uses: number;
  lastUsedAt: string | null;
  /** Ids of the Sessions it was used in, in order of first use. */
  sessions: string[];
}

export interface StatsResult {
  skills: SkillUsage[];
}

/**
 * Aggregate numbers safe to share publicly: counts, averages and Workflow
 * names only. Never User Message text, Task titles, file paths or Projects.
 */
export interface StatsExport {
  exportedAt: string;
  counts: {
    sessions: number;
    tasks: number;
    corrections: number;
    /** Clusters that pass the Repeat Rule now. */
    workflows: number;
    acceptedSkills: number;
    /** Uses of Accepted Skills since they were accepted. */
    skillUses: number;
  };
  /** Over every analyzed Task. */
  correctionsPerTask: CorrectionsPerTask;
  /** The busiest Workflows, by Tasks inside the Repeat Rule's window. */
  topWorkflows: { name: string; tasks: number; sessions: number; correctionsPerTask: CorrectionsPerTask }[];
}

export interface StatsExportOptions {
  /** Replace Workflow names with neutral labels ("Workflow 1", ...). */
  anonymize?: boolean;
}

export interface WorkflowsResult {
  repeatRule: RepeatRule;
  workflows: ClusterView[];
  nearWorkflows: NearWorkflowView[];
}

/** What `recluster` changed: where each old Cluster went, and which Clusters are new. */
export interface ReclusterResult extends ReclusterMapping {
  /** The same for Correction Clusters, which are rebuilt alongside. */
  corrections: ReclusterMapping;
  /** Tokens spent naming the new Clusters. */
  usage: ModelUsage[];
}

/** Where each old Cluster went in a re-cluster, and which Clusters are new. */
export interface ReclusterMapping {
  mapped: { from: ClusterRef; to: ClusterRef }[];
  /** New Clusters that took over from no old one. */
  created: ClusterRef[];
}

export interface ClusterRef {
  id: number;
  name: string;
}

export interface HarnessScanResult {
  harness: HarnessId;
  name: string;
  /** Sessions new to the store. */
  added: number;
  /** Stored Sessions whose content changed since they were last read. */
  updated: number;
  /** Stored Sessions skipped because nothing changed since they were last read. */
  unchanged: number;
  /** Problems the person should know about, such as storage the Adapter did not recognise. */
  warnings: string[];
}

export interface ScanOptions {
  /** Read only the N Sessions with the most recent activity, across all Harnesses. */
  last?: number;
}

export interface ScanResult {
  harnesses: HarnessScanResult[];
}

export interface AnalysisResult {
  /** Ids of the Sessions analyzed. */
  analyzed: string[];
  failed: { session: string; error: string }[];
  /** Tokens the Model Provider reported, per model. */
  usage: ModelUsage[];
  /** True when the Analysis was stopped before every Session was processed. */
  interrupted: boolean;
  /** Sessions left for the next Analysis because it was interrupted (failed Sessions are not counted). */
  remaining: number;
}

export interface AnalyzeOptions {
  /** Stops the Analysis; Sessions already finished are kept, and the next Analysis picks up the rest. */
  signal?: AbortSignal;
}

/** Tokens used (or expected) on one model, and what they cost. */
export interface ModelUsage {
  model: string;
  tokens: TokenCount;
  /** US dollars; null when the model's price is unknown. */
  costUsd: number | null;
}

export interface SuggestResult {
  /** Ids of the Suggestions written. */
  created: number[];
  /** Ids of Pending Suggestions removed because one in `created` supersedes them. */
  replaced: number[];
  /** A Skill that failed names its Workflow; a Rule, its Correction Cluster. */
  failed: ({ workflow: number; error: string } | { correctionCluster: number; error: string })[];
  usage: ModelUsage[];
}

/** What accepting a Suggestion writes (or wrote). */
export interface AcceptResult {
  suggestion: Suggestion;
  files: RenderedFile[];
  /** Files that existed and were backed up before being overwritten; `restore` brings them back. */
  backups: { path: string }[];
}

/** One file accepting a Suggestion would write, before and after. */
export interface FileChange {
  path: string;
  /** Its current content; null when it doesn't exist yet. */
  before: string | null;
  after: string;
  /** A unified diff from `before` to `after`; "" when nothing changes. */
  diff: string;
}

/** What restoring an Accepted Suggestion's backups put back. */
export interface RestoreResult {
  suggestion: Suggestion;
  /** Paths written back to how they were before accepting. */
  files: string[];
}

/** A file's text, or null when it doesn't exist. */
function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** The Scope the person picks for a Suggestion: User scope, or Project scope by a folder inside the Project. */
export type ScopeChoice = { kind: "user" } | { kind: "project"; folder?: string };

/**
 * Whether a source with this Evidence needs a Suggestion written (see
 * `regeneration`), and if so the kind-independent fields to store with it: a
 * replacement keeps a Scope the person chose for the one it replaces.
 */
function nextSuggestion(evidence: Evidence[], prior: readonly PriorSuggestionRow[]) {
  const fingerprint = evidenceFingerprint(evidence);
  const decision = regeneration(fingerprint, prior);
  if (decision.action === "keep") return null;
  const replaced = decision.action === "replace" ? prior.find((p) => p.id === decision.id) : undefined;
  return {
    write: {
      scope: replaced?.scopeOverridden ? replaced.scope : defaultScope(evidence),
      scopeOverridden: replaced?.scopeOverridden,
      evidence,
      fingerprint,
      replaces: replaced?.id,
    },
    /** An Accepted Suggestion whose installed Skill or Rule the new one should target. */
    updates: decision.action === "update" ? decision.id : undefined,
  };
}

/** A Suggestion's editable content: `title` and its kind's fields, each text or a list of text. */
export type SuggestionForm = { title: string; trigger?: string } & Record<string, string | string[]>;

/** An edited Suggestion that can't be saved, e.g. because a field is missing or empty. */
export class SuggestionEditError extends Error {
  override name = "SuggestionEditError";
}

/** Checks an edited form against the current one: same fields, same types, no empty text. */
function validateForm(current: SuggestionForm, edited: unknown): SuggestionForm {
  if (typeof edited !== "object" || edited === null || Array.isArray(edited)) {
    throw new SuggestionEditError("The edited Suggestion must be a JSON object.");
  }
  const fields = Object.keys(current);
  const extra = Object.keys(edited).filter((k) => !fields.includes(k));
  if (extra.length > 0) throw new SuggestionEditError(`Unknown ${extra.length === 1 ? "field" : "fields"}: ${extra.join(", ")}.`);
  const result: Record<string, string | string[]> = {};
  for (const field of fields) {
    const value = (edited as Record<string, unknown>)[field];
    if (Array.isArray(current[field])) {
      const items = Array.isArray(value) && value.every((v) => typeof v === "string") ? value.map((v: string) => v.trim()) : null;
      if (!items || items.length === 0 || items.some((v) => v === "")) {
        throw new SuggestionEditError(`"${field}" must be a non-empty list of non-empty text.`);
      }
      result[field] = items;
    } else {
      if (typeof value !== "string" || value.trim() === "") throw new SuggestionEditError(`"${field}" must be non-empty text.`);
      result[field] = value.trim();
    }
  }
  return result as SuggestionForm;
}

/** A Suggestion id that doesn't exist, or a Suggestion not in a state that allows the action. */
export class SuggestionStateError extends Error {
  override name = "SuggestionStateError";
}

/** Expected token use per model for the Sessions the next Analysis would process. */
export interface AnalysisEstimate {
  /** Number of new or changed Sessions. */
  sessions: number;
  models: ModelUsage[];
}

/** Adds up tokens per model and prices them. */
class UsageTally {
  private readonly tokens = new Map<string, TokenCount>();

  constructor(private readonly prices: Prices = {}) {}

  add(model: string, tokens: TokenCount): void {
    const total = this.tokens.get(model) ?? { input: 0, output: 0 };
    this.tokens.set(model, { input: total.input + tokens.input, output: total.output + tokens.output });
  }

  byModel(): ModelUsage[] {
    return [...this.tokens].map(([model, tokens]) => ({ model, tokens, costUsd: costUsd(model, tokens, this.prices) }));
  }
}

export class App {
  private constructor(
    private readonly deps: AppDependencies,
    private readonly store: Store,
  ) {}

  static open(deps: AppDependencies): App {
    return new App(deps, Store.open(deps.storePath));
  }

  private get projectFilter(): ProjectFilter {
    return this.deps.projectFilter ?? ProjectFilter.allowAll();
  }

  close(): void {
    this.store.close();
  }

  /** Reads every Harness's storage into the store. Never writes to Harness storage. */
  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const scanId = this.store.startScan(this.deps.clock.now());
    this.store.removeSessionsUnless((project) => this.projectFilter.allows(project));
    const counts = new Map<Adapter, { added: number; updated: number; unchanged: number }>();
    const unrecognized = new Map<Adapter, Map<string, number>>();
    const found: { adapter: Adapter; source: SessionSource }[] = [];
    for (const adapter of this.deps.adapters) {
      const storages = await adapter.discover(this.deps.harnessContext);
      if (storages.length === 0) continue; // this Harness has no data on this machine
      counts.set(adapter, { added: 0, updated: 0, unchanged: 0 });
      unrecognized.set(adapter, new Map());
      for (const storage of storages) {
        for await (const source of adapter.listSessions(storage)) found.push({ adapter, source });
      }
    }
    const selected =
      options.last === undefined
        ? found
        : found
            .sort((a, b) => b.source.lastActivityAt.getTime() - a.source.lastActivityAt.getTime())
            .slice(0, options.last);

    for (const { adapter, source } of selected) {
      const count = counts.get(adapter)!;
      if (this.store.sessionFingerprint(adapter.harness, source.externalId) === source.changeMarker) {
        count.unchanged += 1;
        continue;
      }
      const session = await adapter.readSession(source);
      if (!session) continue;
      const project = session.cwd ? resolveProject(session.cwd) : null;
      if (!this.projectFilter.allows(project)) continue;
      const tally = unrecognized.get(adapter)!;
      for (const [shape, n] of Object.entries(session.unrecognized)) tally.set(shape, (tally.get(shape) ?? 0) + n);
      const result = this.store.saveSession({
        harness: adapter.harness,
        session,
        project,
        fingerprint: source.changeMarker,
        scanId,
      });
      if (result.added) count.added += 1;
      else count.updated += 1;
    }

    this.store.finishScan(scanId, this.deps.clock.now());
    return {
      harnesses: [...counts].map(([adapter, count]) => ({
        harness: adapter.harness,
        name: adapter.displayName,
        ...count,
        warnings: unrecognizedWarnings(adapter, unrecognized.get(adapter)!),
      })),
    };
  }

  listSessions(): StoredSession[] {
    // Filtered here too, so a Project excluded since the last Scan is never shown.
    return this.store
      .listSessions()
      .filter((s) => this.projectFilter.allows(s.project && { root: s.project.path, name: s.project.name }));
  }

  getSession(id: string): StoredSessionDetail | null {
    const session = this.store.getSession(id);
    if (!session || !this.projectFilter.allows(session.project && { root: session.project.path, name: session.project.name })) {
      return null;
    }
    return session;
  }

  /** What the next `analyze()` would send, estimated without calling the Model Provider. */
  estimateAnalysis(): AnalysisEstimate {
    const modelProvider = this.requireModelProvider();
    const sessions = this.sessionsToAnalyze();
    const usage = new UsageTally(this.deps.prices);
    for (const session of sessions) usage.add(modelProvider.cheap.modelId, estimateTaskSplit(session.userMessages));
    return { sessions: sessions.length, models: usage.byModel() };
  }

  private requireModelProvider(): ModelProvider {
    if (!this.deps.modelProvider) throw new Error("No Model Provider is configured.");
    return this.deps.modelProvider;
  }

  private sessionsToAnalyze() {
    return this.store.sessionsToAnalyze().filter((s) => this.projectFilter.allows(s.project));
  }

  /**
   * Splits every new or changed Session into Tasks and labels the Intent of
   * each User Message with the cheap model. A Session that fails is reported
   * and left for the next Analysis; the others still complete.
   */
  async analyze(options: AnalyzeOptions = {}): Promise<AnalysisResult> {
    const { signal } = options;
    const modelProvider = this.requireModelProvider();
    const model = modelProvider.cheap;
    const usage = new UsageTally(this.deps.prices);
    const analyzed: string[] = [];
    const failed: AnalysisResult["failed"] = [];
    const sessions = this.sessionsToAnalyze();
    let done = 0;
    for (const session of sessions) {
      if (signal?.aborted) break;
      try {
        const { tasks, tokens } = await splitIntoTasks(model, session.userMessages, signal);
        usage.add(model.modelId, tokens);
        // Each Session is saved on its own, so an interrupted Analysis keeps every Session finished before it.
        if (signal?.aborted) break;
        this.store.saveAnalysis(session.key, session.fingerprint, tasks);
        analyzed.push(session.id);
      } catch (error) {
        if (signal?.aborted) break;
        if (error instanceof MalformedReplyError) usage.add(model.modelId, error.tokens);
        failed.push({ session: session.id, error: error instanceof Error ? error.message : String(error) });
      }
      done += 1;
    }
    if (this.deps.embedder && !signal?.aborted) await this.clusterTasks(this.deps.embedder, model, usage, signal);
    if (this.deps.embedder && !signal?.aborted) await this.clusterCorrections(this.deps.embedder, model, usage, signal);
    const interrupted = done < sessions.length;
    return { analyzed, failed, usage: usage.byModel(), interrupted, remaining: sessions.length - done };
  }

  private get repeatRule(): RepeatRule {
    return this.deps.repeatRule ?? defaultRepeatRule;
  }

  /**
   * Embeds Tasks locally, puts each new Task into the most similar Cluster or a
   * new one (ADR 0008), and names Clusters big enough to be shown. Tasks left
   * unclustered by an interruption are picked up by the next Analysis.
   */
  private async clusterTasks(
    embedder: Embedder,
    model: ModelProvider["cheap"],
    usage: UsageTally,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await this.embedTasks(embedder);
    const placements = placeTasks(
      this.store.clusterVectors(embedder.modelId),
      this.store.unclusteredTasks(embedder.modelId).map((t) => ({ task: t.key, vector: t.vector })),
    );
    this.store.placeTasks(placements, this.deps.clock.now());
    await this.nameClusters(model, usage, signal);
  }

  /** Embeds every Task not yet embedded with `embedder`'s model. */
  private async embedTasks(embedder: Embedder): Promise<void> {
    const toEmbed = this.store.tasksToEmbed(embedder.modelId);
    for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
      const batch = toEmbed.slice(i, i + EMBED_BATCH);
      const vectors = await embedder.embed(batch.map((t) => taskEmbeddingText(t.title, t.firstMessage)));
      this.store.saveEmbeddings(
        embedder.modelId,
        batch.map((t, j) => ({ key: t.key, vector: vectors[j]! })),
      );
    }
  }

  private async nameClusters(model: ModelProvider["cheap"], usage: UsageTally, signal: AbortSignal | undefined): Promise<void> {
    // A Cluster can only be listed once it has this many Tasks, so smaller ones need no name yet.
    const showable = Math.min(NEAR_WORKFLOW_MIN_TASKS, this.repeatRule.minMembers);
    for (const cluster of this.store.unnamedClusters(showable)) {
      if (signal?.aborted) return;
      try {
        const { name, tokens } = await nameCluster(model, cluster.taskTitles, signal);
        usage.add(model.modelId, tokens);
        this.store.nameCluster(cluster.id, name);
      } catch (error) {
        if (error instanceof MalformedReplyError) usage.add(model.modelId, error.tokens);
        // Left unnamed and retried by the next Analysis; listings fall back to a Task title meanwhile.
      }
    }
  }

  /**
   * Rebuilds every Cluster from scratch (ADR 0008), then maps each old Cluster
   * onto the new one holding most of its Tasks. A new Cluster that takes over
   * from an old one keeps its id and name, and anything attached to an old
   * Cluster follows it to the Cluster it mapped to.
   */
  async recluster(options: { signal?: AbortSignal } = {}): Promise<ReclusterResult> {
    const embedder = this.deps.embedder;
    if (!embedder) throw new Error("Re-clustering needs the local Embedder, which is not available.");
    const workflowNames = () => new Map(this.store.listClusters().map((c) => [c.id, c.name ?? c.tasks[0]!.title]));
    const correctionNames = () =>
      new Map(this.store.listCorrectionClusters().map((c) => [c.id, c.name ?? c.corrections[0]!.text]));
    const workflowsBefore = workflowNames();
    const correctionsBefore = correctionNames();
    await this.embedTasks(embedder);
    await this.embedCorrections(embedder);
    const workflows = this.regroup("tasks", this.store.embeddedTasks(embedder.modelId));
    const corrections = this.regroup("corrections", this.store.embeddedCorrections(embedder.modelId));

    const usage = new UsageTally(this.deps.prices);
    const model = this.deps.modelProvider?.cheap;
    if (model) {
      await this.nameClusters(model, usage, options.signal);
      await this.nameCorrectionClusters(model, usage, options.signal);
    }
    return {
      ...workflows.report(workflowsBefore, workflowNames()),
      corrections: corrections.report(correctionsBefore, correctionNames()),
      usage: usage.byModel(),
    };
  }

  /**
   * Groups `members` from scratch and has the new groups take over from the
   * old Clusters (ADR 0008). `report` then says where each old Cluster went,
   * given the Cluster names from before and after.
   */
  private regroup(kind: ClusterKind, members: readonly { key: number; vector: number[]; cluster: number | null }[]) {
    const groups: number[][] = [];
    for (const placement of placeTasks([], members.map((m) => ({ task: m.key, vector: m.vector })))) {
      if ("newCluster" in placement) (groups[placement.newCluster] ??= []).push(placement.task);
    }
    const oldCluster = new Map(members.map((m) => [m.key, m.cluster ?? undefined]));
    const { heirs, targets } = succession(groups, (member: number) => oldCluster.get(member));
    const ids = this.store.recluster(
      kind,
      groups.map((members, i) => ({ heir: heirs[i], members })),
      targets,
      this.deps.clock.now(),
    );
    return {
      report(before: ReadonlyMap<number, string>, after: ReadonlyMap<number, string>): ReclusterMapping {
        const ref = (id: number) => ({ id, name: after.get(id)! });
        return {
          mapped: [...targets]
            .sort(([a], [b]) => a - b)
            .map(([old, group]) => ({ from: { id: old, name: before.get(old)! }, to: ref(ids[group]!) })),
          created: ids.filter((_, i) => heirs[i] === undefined).map(ref),
        };
      },
    };
  }

  /**
   * Embeds Corrections locally and groups them into Correction Clusters across
   * all Tasks, regardless of Workflow, in the same incremental way as Tasks.
   */
  private async clusterCorrections(
    embedder: Embedder,
    model: ModelProvider["cheap"],
    usage: UsageTally,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await this.embedCorrections(embedder);
    const placements = placeTasks(
      this.store.correctionClusterVectors(embedder.modelId),
      this.store.unclusteredCorrections(embedder.modelId).map((c) => ({ task: c.key, vector: c.vector })),
    );
    this.store.placeCorrections(placements, this.deps.clock.now());
    await this.nameCorrectionClusters(model, usage, signal);
  }

  /** Embeds every Correction not yet embedded with `embedder`'s model. */
  private async embedCorrections(embedder: Embedder): Promise<void> {
    const toEmbed = this.store.correctionsToEmbed(embedder.modelId);
    for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
      const batch = toEmbed.slice(i, i + EMBED_BATCH);
      const vectors = await embedder.embed(batch.map((c) => c.text));
      this.store.saveCorrectionEmbeddings(
        embedder.modelId,
        batch.map((c, j) => ({ key: c.key, vector: vectors[j]! })),
      );
    }
  }

  private async nameCorrectionClusters(
    model: ModelProvider["cheap"],
    usage: UsageTally,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const showable = Math.min(NEAR_WORKFLOW_MIN_TASKS, this.repeatRule.minMembers);
    for (const cluster of this.store.unnamedCorrectionClusters(showable)) {
      if (signal?.aborted) return;
      try {
        const { name, tokens } = await nameCorrectionCluster(model, cluster.corrections, signal);
        usage.add(model.modelId, tokens);
        this.store.nameCorrectionCluster(cluster.id, name);
      } catch (error) {
        if (error instanceof MalformedReplyError) usage.add(model.modelId, error.tokens);
        // Left unnamed and retried by the next Analysis; listings fall back to a Correction's text meanwhile.
      }
    }
  }

  /** Correction Clusters that pass the Repeat Rule now, and those close to passing. */
  listCorrections(): CorrectionsResult {
    const rule = this.repeatRule;
    const now = this.deps.clock.now();
    const result: CorrectionsResult = { repeatRule: rule, correctionClusters: [], nearCorrectionClusters: [] };
    for (const cluster of this.store.listCorrectionClusters()) {
      const corrections = cluster.corrections.filter((c) =>
        this.projectFilter.allows(c.project && { root: c.project.path, name: c.project.name }),
      );
      if (corrections.length === 0) continue;
      const verdict = applyRepeatRule(
        corrections.map((c) => ({ session: c.session, at: new Date(c.at) })),
        rule,
        now,
      );
      const sessions = new Map<string, CorrectionClusterView["sessions"][number]>();
      for (const c of corrections) {
        if (!sessions.has(c.session)) sessions.set(c.session, { id: c.session, harness: c.harness, project: c.project });
      }
      const view: CorrectionClusterView = {
        id: cluster.id,
        name: cluster.name ?? corrections[0]!.text,
        corrections,
        sessions: [...sessions.values()],
        harnesses: [...new Set(corrections.map((c) => c.harness))],
        counted: { corrections: verdict.counted.members, sessions: verdict.counted.sessions },
      };
      if (verdict.passes) result.correctionClusters.push(view);
      else if (verdict.counted.members >= Math.min(NEAR_WORKFLOW_MIN_TASKS, rule.minMembers)) {
        result.nearCorrectionClusters.push({
          ...view,
          needs: { corrections: verdict.needs.members, sessions: verdict.needs.sessions },
        });
      }
    }
    const busiestFirst = (a: CorrectionClusterView, b: CorrectionClusterView) =>
      b.counted.corrections - a.counted.corrections || a.id - b.id;
    result.correctionClusters.sort(busiestFirst);
    result.nearCorrectionClusters.sort(busiestFirst);
    return result;
  }

  /** Clusters that pass the Repeat Rule now, and those close to passing. */
  listWorkflows(): WorkflowsResult {
    const rule = this.repeatRule;
    const now = this.deps.clock.now();
    const result: WorkflowsResult = { repeatRule: rule, workflows: [], nearWorkflows: [] };
    for (const cluster of this.store.listClusters()) {
      const judged = this.clusterView(cluster, now);
      if (!judged) continue;
      const { view, verdict } = judged;
      if (verdict.passes) result.workflows.push(view);
      else if (verdict.counted.members >= Math.min(NEAR_WORKFLOW_MIN_TASKS, rule.minMembers)) {
        result.nearWorkflows.push({ ...view, needs: { tasks: verdict.needs.members, sessions: verdict.needs.sessions } });
      }
    }
    const busiestFirst = (a: ClusterView, b: ClusterView) => b.counted.tasks - a.counted.tasks || a.id - b.id;
    result.workflows.sort(busiestFirst);
    result.nearWorkflows.sort(busiestFirst);
    return result;
  }

  /**
   * Workflows and near-Workflows for the Workflows screen. Whether a Cluster
   * is a Workflow is decided on all its Tasks; the filter only narrows which
   * Tasks are counted and shown, and a Workflow with none left is left out.
   */
  browseWorkflows(filter: BrowseFilter = {}): WorkflowList {
    const { repeatRule, workflows, nearWorkflows } = this.listWorkflows();
    const suggestions = this.latestSuggestions();
    const summarize = (view: ClusterView): WorkflowSummary | null => {
      const tasks = view.tasks.filter((t) => matchesFilter(filter, t));
      if (tasks.length === 0) return null;
      const suggestion = suggestions.get(view.id);
      return {
        id: view.id,
        name: view.name,
        tasks: tasks.length,
        sessions: new Set(tasks.map((t) => t.session)).size,
        harnesses: distinct(tasks.map((t) => t.harness), (h) => h),
        projects: distinct(
          tasks.flatMap((t) => (t.project ? [{ name: t.project.name, path: t.project.path }] : [])),
          (p) => p.path,
        ),
        suggestion: suggestion ? { id: suggestion.id, state: suggestion.state } : null,
        correctionsPerTask: correctionsPerTask(tasks).overall,
      };
    };
    return {
      repeatRule,
      workflows: workflows.flatMap((w) => summarize(w) ?? []),
      nearWorkflows: nearWorkflows.flatMap((w) => {
        const summary = summarize(w);
        return summary ? [{ ...summary, needs: w.needs }] : [];
      }),
      filters: filterOptions(this.listSessions()),
    };
  }

  /**
   * One Cluster for the Workflows screen, with its Tasks within the filter and
   * all its Suggestions. Null as for `getWorkflow`.
   */
  browseWorkflow(id: number, filter: BrowseFilter = {}): WorkflowDetail | null {
    const judged = this.judgedCluster(id);
    if (!judged) return null;
    const { view, verdict } = judged;
    const tasks = view.tasks.filter((t) => matchesFilter(filter, t));
    return {
      id: view.id,
      name: view.name,
      passesRepeatRule: verdict.passes,
      tasks,
      correctionsPerTask: correctionsPerTask(tasks),
      sessions: new Set(tasks.map((t) => t.session)).size,
      harnesses: distinct(tasks.map((t) => t.harness), (h) => h),
      suggestions: this.store
        .listSuggestions()
        .filter((s) => s.kind === "skill" && s.workflow?.id === view.id)
        .map((s) => ({ id: s.id, state: s.state, title: s.title })),
      filters: filterOptions(this.listSessions()),
    };
  }

  /** Sessions for the Session list, latest first, narrowed by the filter (by when they started). */
  browseSessions(filter: BrowseFilter = {}): SessionList {
    const sessions = this.listSessions();
    return {
      sessions: sessions.filter((s) => matchesFilter(filter, { ...s, at: s.startedAt })),
      filters: filterOptions(sessions),
    };
  }

  /**
   * One Session for the Session viewer: every message, each in the Task it
   * belongs to, with User Messages' Intents so Corrections can be marked.
   * Null if no Session has that id or its Project is excluded.
   */
  viewSession(id: string): SessionView | null {
    const session = this.getSession(id);
    if (!session) return null;
    const { messages, ...rest } = session;
    const analysis = this.store.sessionAnalysis(session.harness, session.id);
    const { workflows, nearWorkflows } = this.listWorkflows();
    const shown = new Map([...workflows, ...nearWorkflows].map((w) => [w.id, { id: w.id, name: w.name }]));

    // A Harness whose Adapter does not read every message still has its User Messages.
    const stored: StoredMessage[] =
      messages.length > 0 ? messages : analysis.userMessages.map((m) => ({ role: "user", text: m.text, timestamp: null }));
    const pending = [...analysis.userMessages];
    let task: number | null = null;
    const viewed = stored.map((message): SessionViewMessage => {
      const isUserMessage = message.role === "user" && !message.subagent && pending[0]?.text === message.text;
      if (!isUserMessage) return { ...message, task };
      const userMessage = pending.shift()!;
      task = userMessage.task;
      return userMessage.intent ? { ...message, task, intent: userMessage.intent } : { ...message, task };
    });
    return {
      ...rest,
      tasks: analysis.tasks.map((t) => ({
        position: t.position,
        title: t.title,
        workflow: (t.cluster !== null && shown.get(t.cluster)) || null,
        corrections: analysis.userMessages.filter((m) => m.task === t.position && m.intent === "Correction").length,
      })),
      messages: viewed,
    };
  }

  /**
   * The mind map of Workflows' Tasks within the filter: Project → Workflow →
   * Task → Session, with Suggestions under their Workflow. A Workflow with no
   * Task left is left out; near-Workflows are not shown.
   */
  mindMap(filter: BrowseFilter = {}): MindMap {
    const allSessions = this.listSessions();
    const sessions = new Map(allSessions.map((s) => [`${s.harness}:${s.id}`, s]));
    const suggestions = this.store.listSuggestions().filter((s): s is SkillSuggestion => s.kind === "skill");
    const nodes = new Map<string, MindMapNode>();
    const edges = new Map<string, MindMapEdge>();
    const link = (source: string, target: string) => {
      const id = `${source}->${target}`;
      if (!edges.has(id)) edges.set(id, { id, source, target });
    };
    const addHarness = (id: string, harness: HarnessId) => {
      const node = nodes.get(id)!;
      if (!node.harnesses.includes(harness)) node.harnesses.push(harness);
    };
    const projectNodes: MindMapNode[] = [];
    const rest: MindMapNode[] = [];
    const add = (node: MindMapNode, into: MindMapNode[] = rest) => {
      if (nodes.has(node.id)) return;
      nodes.set(node.id, node);
      into.push(node);
    };

    for (const workflow of this.listWorkflows().workflows) {
      const tasks = workflow.tasks.filter((t) => matchesFilter(filter, t));
      if (tasks.length === 0) continue;
      const workflowId = `workflow:${workflow.id}`;
      const harnesses = distinct(tasks.map((t) => t.harness), (h) => h);
      add({
        id: workflowId,
        kind: "workflow",
        label: workflow.name,
        harnesses,
        workflow: workflow.id,
        tasks: tasks.length,
        sessions: new Set(tasks.map((t) => `${t.harness}:${t.session}`)).size,
        correctionsPerTask: correctionsPerTask(tasks).overall,
      });
      for (const t of tasks) {
        if (t.project) {
          const projectId = `project:${t.project.path}`;
          add({ id: projectId, kind: "project", label: t.project.name, path: t.project.path, harnesses: [] }, projectNodes);
          addHarness(projectId, t.harness);
          link(projectId, workflowId);
        }
        const taskId = `task:${t.harness}:${t.session}:${t.position}`;
        add({
          id: taskId,
          kind: "task",
          label: t.title,
          harnesses: [t.harness],
          session: t.session,
          position: t.position,
          at: t.at,
          corrections: t.corrections,
        });
        link(workflowId, taskId);
        const stored = sessions.get(`${t.harness}:${t.session}`);
        const startedAt = stored?.startedAt ?? t.at;
        const sessionId = `session:${t.harness}:${t.session}`;
        add({
          id: sessionId,
          kind: "session",
          label: `${t.project?.name ?? "No Project"} · ${startedAt.slice(0, 10)}`,
          harnesses: [t.harness],
          session: t.session,
          project: t.project,
          startedAt,
        });
        link(taskId, sessionId);
      }
      for (const s of suggestions.filter((s) => s.workflow?.id === workflow.id)) {
        const suggestionId = `suggestion:${s.id}`;
        add({ id: suggestionId, kind: "suggestion", label: s.title, harnesses, suggestion: s.id, state: s.state });
        link(workflowId, suggestionId);
      }
    }
    return { nodes: [...projectNodes, ...rest], edges: [...edges.values()], filters: filterOptions(allSessions) };
  }

  /** Each Workflow's latest Suggestion. */
  private latestSuggestions(): Map<number, SuggestionRef & { title: string }> {
    const latest = new Map<number, SuggestionRef & { title: string }>();
    for (const s of this.store.listSuggestions()) {
      if (s.kind === "skill" && s.workflow) latest.set(s.workflow.id, { id: s.id, state: s.state, title: s.title });
    }
    return latest;
  }

  /** Measuring numbers: how often Accepted Skills are used. */
  stats(): StatsResult {
    return { skills: this.skillUsage() };
  }

  /** Aggregate numbers to share publicly; see `StatsExport` for what it leaves out. */
  exportStats(options: StatsExportOptions = {}): StatsExport {
    const tasks = this.store
      .taskCorrections()
      .filter((t) => this.projectFilter.allows(t.project && { root: t.project.path, name: t.project.name }));
    const workflows = this.listWorkflows().workflows;
    const skills = this.skillUsage();
    // An unnamed Cluster's fallback name is a Task title, which is not safe to share.
    const named = new Set(this.store.listClusters().filter((c) => c.name).map((c) => c.id));
    return {
      exportedAt: this.deps.clock.now().toISOString(),
      counts: {
        sessions: this.listSessions().length,
        tasks: tasks.length,
        corrections: tasks.reduce((sum, t) => sum + t.corrections, 0),
        workflows: workflows.length,
        acceptedSkills: skills.length,
        skillUses: skills.reduce((sum, s) => sum + s.uses, 0),
      },
      correctionsPerTask: correctionsPerTask(tasks),
      topWorkflows: workflows.slice(0, TOP_WORKFLOWS).map((w, i) => ({
        name: options.anonymize || !named.has(w.id) ? `Workflow ${i + 1}` : w.name,
        tasks: w.counted.tasks,
        sessions: w.counted.sessions,
        correctionsPerTask: w.correctionsPerTask,
      })),
    };
  }

  /**
   * Uses of each Accepted Skill that Scan found since it was accepted. A use
   * counts when it names the installed skill folder and, if the Harness
   * recorded the folder it loaded, that folder is the installed one.
   */
  private skillUsage(): SkillUsage[] {
    return this.store
      .listSuggestions("Accepted")
      .filter((s) => s.kind === "skill" && s.acceptedAt !== null)
      .map((s) => {
        const folders = s.installedFiles.map((file) => dirname(file));
        const uses = folders.flatMap((folder) =>
          this.store
            .skillUses(basename(folder))
            .filter((u) => u.at >= s.acceptedAt! && (u.baseDir === null || u.baseDir === folder)),
        );
        uses.sort((a, b) => a.at.localeCompare(b.at));
        return {
          suggestion: s.id,
          title: s.title,
          acceptedAt: s.acceptedAt!,
          uses: uses.length,
          lastUsedAt: uses.at(-1)?.at ?? null,
          sessions: [...new Set(uses.map((u) => u.session))],
        };
      });
  }

  /** Sessions, Tasks and Workflows at a glance, with Corrections over time. */
  overview(): Overview {
    const workflows = this.listWorkflows().workflows;
    const messages = this.store
      .analyzedUserMessages()
      .filter((m) => this.projectFilter.allows(m.project && { root: m.project.path, name: m.project.name }));
    return {
      counts: {
        sessions: this.listSessions().length,
        tasks: this.listTasks().reduce((sum, s) => sum + s.tasks.length, 0),
        workflows: workflows.length,
      },
      topWorkflows: workflows
        .slice(0, TOP_WORKFLOWS)
        .map((w) => ({ id: w.id, name: w.name, tasks: w.counted.tasks, sessions: w.counted.sessions })),
      corrections: correctionsPerWeek(
        messages.map((m) => ({ at: m.at, correction: m.intent === "Correction" })),
        this.deps.clock.now(),
      ),
    };
  }

  /**
   * One Cluster, whether or not it passes the Repeat Rule. The id may be one a
   * re-cluster retired; it then shows the Cluster that id mapped to. Null if
   * no Cluster has or had that id, or none of its Tasks may be shown.
   */
  getWorkflow(id: number): ClusterView | null {
    return this.judgedCluster(id)?.view ?? null;
  }

  private judgedCluster(id: number): { view: ClusterView; verdict: RepeatRuleResult } | null {
    const current = this.store.resolveCluster("tasks", id);
    const cluster = current === null ? undefined : this.store.listClusters().find((c) => c.id === current);
    return (cluster && this.clusterView(cluster, this.deps.clock.now())) ?? null;
  }

  private clusterView(cluster: StoredCluster, now: Date): { view: ClusterView; verdict: RepeatRuleResult } | null {
    const tasks = cluster.tasks.filter((t) => this.projectFilter.allows(t.project && { root: t.project.path, name: t.project.name }));
    if (tasks.length === 0) return null;
    const verdict = applyRepeatRule(
      tasks.map((t) => ({ session: t.session, at: new Date(t.at) })),
      this.repeatRule,
      now,
    );
    const sessions = new Map<string, ClusterView["sessions"][number]>();
    for (const t of tasks) if (!sessions.has(t.session)) sessions.set(t.session, { id: t.session, harness: t.harness, project: t.project });
    const view: ClusterView = {
      id: cluster.id,
      name: cluster.name ?? tasks[0]!.title,
      tasks,
      sessions: [...sessions.values()],
      harnesses: [...new Set(tasks.map((t) => t.harness))],
      counted: { tasks: verdict.counted.members, sessions: verdict.counted.sessions },
      correctionsPerTask: correctionsPerTask(tasks),
    };
    return { view, verdict };
  }

  /**
   * Writes a Skill Suggestion with the strong model for every Workflow that
   * needs one (see `regeneration`): none yet, or a Pending one written before
   * the Workflow gained several new Tasks, which the new one replaces. A
   * Workflow whose Suggestion was Rejected gets none, so it isn't proposed
   * again. Nothing is written outside the store.
   */
  async suggest(options: AnalyzeOptions = {}): Promise<SuggestResult> {
    const { signal } = options;
    const model = this.requireModelProvider().strong;
    const usage = new UsageTally(this.deps.prices);
    const result: SuggestResult = { created: [], replaced: [], failed: [], usage: [] };
    const overlaps = new Overlaps(this.deps.renderers ?? [], this.installedContext.bind(this), this.deps.embedder);
    const prior = this.store.priorSuggestions("skill");
    for (const workflow of this.listWorkflows().workflows) {
      if (signal?.aborted) break;
      const evidence: Evidence[] = workflow.tasks.map((t) => ({
        task: { title: t.title, at: t.at },
        session: { id: t.session, harness: t.harness },
        project: t.project,
      }));
      const next = nextSuggestion(evidence, prior);
      if (!next) continue;
      const tasks = workflow.tasks.map((t) => ({
        title: t.title,
        userMessages: this.store.taskMessages(t.harness, t.session, t.position),
      }));
      try {
        // An owned Skill that covers the Workflow is its Target; failing that, a plugin skill gets a companion.
        const skills = (await overlaps.find("skill", workflow.name, evidence, this.acceptedSuggestion(next.updates))).filter((i) => i.kind === "skill");
        const owned = skills.find((s) => s.plugin === null);
        const plugin = owned ? undefined : skills.find((s) => s.plugin !== null);
        const { skill, tokens } = await writeSkill(
          model,
          {
            name: workflow.name,
            tasks,
            existing: owned && { name: owned.name, content: owned.content },
            companionOf: plugin && { name: `${plugin.plugin}:${plugin.name}`, description: plugin.description },
          },
          signal,
        );
        usage.add(model.modelId, tokens);
        if (signal?.aborted) break;
        const target: Target | null = owned ? { kind: "skill", path: owned.path, name: owned.name } : null;
        const id = this.store.createSuggestion({
          kind: "skill",
          workflow: { id: workflow.id, name: workflow.name },
          title: skill.title,
          trigger: skill.trigger,
          steps: skill.steps,
          ...withTarget(next.write, target),
          companionOf: plugin ? { plugin: plugin.plugin!, name: plugin.name } : null,
          createdAt: this.deps.clock.now(),
        });
        result.created.push(id);
        if (next.write.replaces !== undefined) result.replaced.push(next.write.replaces);
      } catch (error) {
        if (signal?.aborted) break;
        if (error instanceof MalformedReplyError) usage.add(model.modelId, error.tokens);
        result.failed.push({ workflow: workflow.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!signal?.aborted) await this.suggestRules(model, usage, result, overlaps, signal);
    result.usage = usage.byModel();
    return result;
  }

  /** Writes a Rule Suggestion for every qualifying Correction Cluster that needs one, as `suggest` does for Workflows. */
  private async suggestRules(
    model: ModelProvider["strong"],
    usage: UsageTally,
    result: SuggestResult,
    overlaps: Overlaps,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const prior = this.store.priorSuggestions("rule");
    for (const cluster of this.listCorrections().correctionClusters) {
      if (signal?.aborted) return;
      const evidence: Evidence[] = cluster.corrections.map((c) => ({
        correction: { text: c.text, at: c.at },
        task: { title: c.task, at: c.taskAt },
        session: { id: c.session, harness: c.harness },
        project: c.project,
      }));
      const next = nextSuggestion(evidence, prior);
      if (!next) continue;
      try {
        // A line already saying this is the Rule's Target, so accepting replaces it instead of adding a second one.
        const [line] = (await overlaps.find("rule", cluster.name, evidence, this.acceptedSuggestion(next.updates))).filter((i) => i.kind === "rule");
        const { rule, tokens } = await writeRule(
          model,
          {
            name: cluster.name,
            corrections: cluster.corrections.map((c) => ({ text: c.text, task: c.task })),
            existingLine: line?.line,
          },
          signal,
        );
        usage.add(model.modelId, tokens);
        if (signal?.aborted) return;
        const id = this.store.createSuggestion({
          kind: "rule",
          correctionCluster: { id: cluster.id, name: cluster.name },
          title: rule.title,
          rule: rule.rule,
          ...withTarget(next.write, line ? { kind: "rule", path: line.path, line: line.line } : null),
          createdAt: this.deps.clock.now(),
        });
        result.created.push(id);
        if (next.write.replaces !== undefined) result.replaced.push(next.write.replaces);
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof MalformedReplyError) usage.add(model.modelId, error.tokens);
        result.failed.push({ correctionCluster: cluster.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /** Suggestions, oldest first, optionally only those in `state`. */
  listSuggestions(state?: SuggestionState): Suggestion[] {
    return this.store.listSuggestions(state);
  }

  getSuggestion(id: number): Suggestion | null {
    return this.store.getSuggestion(id);
  }

  /** The files accepting a Pending Suggestion would write, without writing them. */
  previewSuggestion(id: number): RenderedFile[] {
    return this.render(this.pendingSuggestion(id));
  }

  /**
   * What accepting a Pending Suggestion would change in each file, as a
   * unified diff against its current content. Pure, like `previewSuggestion`.
   */
  suggestionChanges(id: number): FileChange[] {
    return this.render(this.pendingSuggestion(id)).map((file) => {
      const before = readText(file.path);
      return { path: file.path, before, after: file.content, diff: unifiedDiff(file.path, before, file.content) };
    });
  }

  /**
   * Renders a Pending Suggestion, writes its files and marks it Accepted. A
   * file that already exists, such as a Target, is backed up first so
   * `restoreSuggestion` can bring it back.
   */
  acceptSuggestion(id: number): AcceptResult {
    const suggestion = this.pendingSuggestion(id);
    const files = this.render(suggestion);
    const now = this.deps.clock.now();
    const backups: AcceptResult["backups"] = [];
    for (const file of files) {
      const before = readText(file.path);
      if (before === null || before === file.content) continue;
      this.store.addBackup(id, file.path, before, now);
      backups.push({ path: file.path });
    }
    for (const file of files) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
    }
    this.store.markAccepted(id, now, files.map((f) => f.path));
    return { suggestion: this.store.getSuggestion(id)!, files, backups };
  }

  /** Puts back the files an Accepted Suggestion overwrote, as they were just before it was accepted. */
  restoreSuggestion(id: number): RestoreResult {
    const suggestion = this.store.getSuggestion(id);
    if (!suggestion) throw new SuggestionStateError(`No Suggestion has id ${id}.`);
    if (suggestion.state !== "Accepted") {
      throw new SuggestionStateError(`Suggestion ${id} is ${suggestion.state}; only an Accepted Suggestion can be restored.`);
    }
    const backups = this.store.backups(id);
    if (backups.length === 0) throw new SuggestionStateError(`Suggestion ${id} changed no existing file, so there is nothing to restore.`);
    if (backups.every((b) => b.restoredAt !== null)) {
      throw new SuggestionStateError(`Suggestion ${id} was already restored.`);
    }
    const now = this.deps.clock.now();
    const files: string[] = [];
    for (const backup of backups) {
      if (backup.restoredAt !== null) continue;
      mkdirSync(dirname(backup.path), { recursive: true });
      writeFileSync(backup.path, backup.content);
      this.store.markRestored(backup.id, now);
      files.push(backup.path);
    }
    return { suggestion, files };
  }

  /**
   * A Pending Suggestion's content in the format-neutral form, as the person
   * edits it: `title` and the fields of its kind (`trigger` and `steps` for a
   * Skill, `rule` for a Rule).
   */
  suggestionForm(id: number): SuggestionForm {
    const { kind } = this.pendingSuggestion(id, "edited");
    const { title, trigger, body } = this.store.suggestionContent(id)!;
    return (kind === "skill" ? { title, trigger, ...body } : { title, ...body }) as SuggestionForm;
  }

  /**
   * Saves the person's edit of a Pending Suggestion. The form must keep every
   * field of `suggestionForm(id)` with the same type, so this works for any kind.
   */
  editSuggestion(id: number, form: unknown): Suggestion {
    const { title, trigger, ...body } = validateForm(this.suggestionForm(id), form);
    this.store.editSuggestion(id, { title, trigger: trigger ?? "", body }, this.deps.clock.now());
    return this.store.getSuggestion(id)!;
  }

  /**
   * Overrides where a Pending Suggestion will be installed. Project scope takes
   * a folder inside the Project; without one, the single Project its Evidence
   * comes from.
   */
  setScope(id: number, choice: ScopeChoice): Suggestion {
    const suggestion = this.pendingSuggestion(id, "re-scoped");
    let scope: Scope;
    if (choice.kind === "user") scope = { kind: "user" };
    else if (choice.folder !== undefined) {
      const project = resolveProject(choice.folder);
      scope = { kind: "project", project: { name: project.name, path: project.root } };
    } else {
      const fromEvidence = defaultScope(suggestion.evidence);
      if (fromEvidence.kind !== "project") {
        throw new SuggestionStateError(
          `Suggestion ${id}'s Evidence comes from several Projects (or none); name a folder in the Project to install it in.`,
        );
      }
      scope = fromEvidence;
    }
    this.store.overrideScope(id, scope);
    return this.store.getSuggestion(id)!;
  }

  /** Marks a Pending Suggestion Rejected; it stays in the store so it isn't proposed again. */
  rejectSuggestion(id: number): Suggestion {
    this.pendingSuggestion(id);
    this.store.markRejected(id, this.deps.clock.now());
    return this.store.getSuggestion(id)!;
  }

  private pendingSuggestion(id: number, action = "accepted or rejected"): Suggestion {
    const suggestion = this.store.getSuggestion(id);
    if (!suggestion) throw new SuggestionStateError(`No Suggestion has id ${id}.`);
    if (suggestion.state !== "Pending") {
      throw new SuggestionStateError(`Suggestion ${id} is already ${suggestion.state}; only Pending Suggestions can be ${action}.`);
    }
    return suggestion;
  }

  private render(suggestion: Suggestion): RenderedFile[] {
    const renderers = (this.deps.renderers ?? []).filter((r) => r.kind === suggestion.kind);
    if (renderers.length === 0) throw new Error(`No Renderer is available for ${suggestion.kind} Suggestions.`);
    const context: RenderContext = { homeDir: this.deps.harnessContext.homeDir, readFile: readText };
    return renderers.flatMap((r) => r.render(suggestion, context));
  }

  private acceptedSuggestion(id: number | undefined): Suggestion | undefined {
    return id === undefined ? undefined : (this.store.getSuggestion(id) ?? undefined);
  }

  /** What Renderers read to list installed Skills and Rules: the User scope ones and those of `projects`. */
  private installedContext(projects: readonly ProjectRef[]): InstalledContext {
    return {
      homeDir: this.deps.harnessContext.homeDir,
      projects,
      readFile: readText,
      listDir: (path) => {
        try {
          return readdirSync(path, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
        } catch {
          return [];
        }
      },
    };
  }

  /** The redacted text Analysis would send for a Session, or null if no Session has that id. */
  redactedRequest(sessionId: string): string | null {
    const session = this.store.sessionWithMessages(sessionId);
    if (!session || !this.projectFilter.allows(session.project)) return null;
    return taskSplitPrompt(session.userMessages);
  }

  listTasks(): SessionTasks[] {
    return this.store
      .listTasks()
      .filter((s) => this.projectFilter.allows(s.project && { root: s.project.path, name: s.project.name }));
  }
}

/** Texts embedded per Embedder call. */
const EMBED_BATCH = 32;

/** A Cluster that fails the Repeat Rule is a near-Workflow once it has this many Tasks inside the window. */
const NEAR_WORKFLOW_MIN_TASKS = 2;

function unrecognizedWarnings(adapter: Adapter, tally: Map<string, number>): string[] {
  if (tally.size === 0) return [];
  const total = [...tally.values()].reduce((sum, n) => sum + n, 0);
  const shapes = [...tally]
    .sort((a, b) => b[1] - a[1])
    .map(([shape, n]) => `${shape}: ${n}`)
    .join(", ");
  return [
    `${adapter.displayName}: skipped ${total} ${total === 1 ? "record" : "records"} sessionlore does not recognise (${shapes}). ` +
      `${adapter.displayName} may have changed its storage format; please report this so sessionlore can read it.`,
  ];
}
