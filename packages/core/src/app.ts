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
  writeSkill,
  type RepeatRule,
  type RepeatRuleResult,
  type TokenCount,
} from "@sessionlore/analysis";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  defaultScope,
  type Evidence,
  type RenderContext,
  type RenderedFile,
  type Renderer,
  type Suggestion,
  type SuggestionState,
} from "./suggestion.js";
import { costUsd, type Prices } from "./pricing.js";
import {
  Store,
  type ClusterCorrection,
  type ClusterKind,
  type ClusterTask,
  type SessionTasks,
  type StoredCluster,
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
  failed: { workflow: number; error: string }[];
  usage: ModelUsage[];
}

/** What accepting a Suggestion writes (or wrote). */
export interface AcceptResult {
  suggestion: Suggestion;
  files: RenderedFile[];
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
   * One Cluster, whether or not it passes the Repeat Rule. The id may be one a
   * re-cluster retired; it then shows the Cluster that id mapped to. Null if
   * no Cluster has or had that id, or none of its Tasks may be shown.
   */
  getWorkflow(id: number): ClusterView | null {
    const current = this.store.resolveCluster("tasks", id);
    const cluster = current === null ? undefined : this.store.listClusters().find((c) => c.id === current);
    return (cluster && this.clusterView(cluster, this.deps.clock.now())?.view) ?? null;
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
    };
    return { view, verdict };
  }

  /**
   * Writes a Skill Suggestion with the strong model for every Workflow that has
   * no Suggestion yet. A Workflow whose Suggestion was Rejected gets none, so
   * it isn't proposed again. Nothing is written outside the store.
   */
  async suggest(options: AnalyzeOptions = {}): Promise<SuggestResult> {
    const { signal } = options;
    const model = this.requireModelProvider().strong;
    const usage = new UsageTally(this.deps.prices);
    const result: SuggestResult = { created: [], failed: [], usage: [] };
    const suggested = this.store.workflowsWithSuggestions("skill");
    for (const workflow of this.listWorkflows().workflows) {
      if (signal?.aborted) break;
      if (suggested.has(workflow.id)) continue;
      const evidence: Evidence[] = workflow.tasks.map((t) => ({
        task: { title: t.title, at: t.at },
        session: { id: t.session, harness: t.harness },
        project: t.project,
      }));
      const tasks = workflow.tasks.map((t) => ({
        title: t.title,
        userMessages: this.store.taskMessages(t.harness, t.session, t.position),
      }));
      try {
        const { skill, tokens } = await writeSkill(model, { name: workflow.name, tasks }, signal);
        usage.add(model.modelId, tokens);
        if (signal?.aborted) break;
        const id = this.store.createSuggestion({
          kind: "skill",
          workflow: { id: workflow.id, name: workflow.name },
          title: skill.title,
          trigger: skill.trigger,
          body: { steps: skill.steps },
          scope: defaultScope(evidence),
          evidence,
          createdAt: this.deps.clock.now(),
        });
        result.created.push(id);
      } catch (error) {
        if (signal?.aborted) break;
        if (error instanceof MalformedReplyError) usage.add(model.modelId, error.tokens);
        result.failed.push({ workflow: workflow.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    result.usage = usage.byModel();
    return result;
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

  /** Renders a Pending Suggestion, writes its files and marks it Accepted. */
  acceptSuggestion(id: number): AcceptResult {
    const suggestion = this.pendingSuggestion(id);
    const files = this.render(suggestion);
    for (const file of files) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
    }
    this.store.markAccepted(id, this.deps.clock.now(), files.map((f) => f.path));
    return { suggestion: this.store.getSuggestion(id)!, files };
  }

  /** Marks a Pending Suggestion Rejected; it stays in the store so it isn't proposed again. */
  rejectSuggestion(id: number): Suggestion {
    this.pendingSuggestion(id);
    this.store.markRejected(id, this.deps.clock.now());
    return this.store.getSuggestion(id)!;
  }

  private pendingSuggestion(id: number): Suggestion {
    const suggestion = this.store.getSuggestion(id);
    if (!suggestion) throw new SuggestionStateError(`No Suggestion has id ${id}.`);
    if (suggestion.state !== "Pending") {
      throw new SuggestionStateError(
        `Suggestion ${id} is already ${suggestion.state}; only Pending Suggestions can be accepted or rejected.`,
      );
    }
    return suggestion;
  }

  private render(suggestion: Suggestion): RenderedFile[] {
    const renderers = (this.deps.renderers ?? []).filter((r) => r.kind === suggestion.kind);
    if (renderers.length === 0) throw new Error(`No Renderer is available for ${suggestion.kind} Suggestions.`);
    const context: RenderContext = {
      homeDir: this.deps.harnessContext.homeDir,
      readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    };
    return renderers.flatMap((r) => r.render(suggestion, context));
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
