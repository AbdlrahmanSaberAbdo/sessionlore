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
  placeTasks,
  splitIntoTasks,
  succession,
  taskEmbeddingText,
  taskSplitPrompt,
  type RepeatRule,
  type RepeatRuleResult,
  type TokenCount,
} from "@sessionlore/analysis";
import { costUsd, type Prices } from "./pricing.js";
import {
  Store,
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
export interface ReclusterResult {
  mapped: { from: ClusterRef; to: ClusterRef }[];
  /** New Clusters that took over from no old one. */
  created: ClusterRef[];
  /** Tokens spent naming the new Clusters. */
  usage: ModelUsage[];
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
    const before = new Map(this.store.listClusters().map((c) => [c.id, clusterName(c)]));
    await this.embedTasks(embedder);
    const tasks = this.store.embeddedTasks(embedder.modelId);
    const groups: number[][] = [];
    for (const placement of placeTasks([], tasks.map((t) => ({ task: t.key, vector: t.vector })))) {
      if ("newCluster" in placement) (groups[placement.newCluster] ??= []).push(placement.task);
    }
    const oldCluster = new Map(tasks.map((t) => [t.key, t.cluster ?? undefined]));
    const { heirs, targets } = succession(groups, (task: number) => oldCluster.get(task));
    const ids = this.store.recluster(
      groups.map((tasks, i) => ({ heir: heirs[i], tasks })),
      targets,
      this.deps.clock.now(),
    );

    const usage = new UsageTally(this.deps.prices);
    if (this.deps.modelProvider) await this.nameClusters(this.deps.modelProvider.cheap, usage, options.signal);
    const after = new Map(this.store.listClusters().map((c) => [c.id, clusterName(c)]));
    const ref = (id: number) => ({ id, name: after.get(id)! });
    return {
      mapped: [...targets]
        .sort(([a], [b]) => a - b)
        .map(([old, group]) => ({ from: { id: old, name: before.get(old)! }, to: ref(ids[group]!) })),
      created: ids.filter((_, i) => heirs[i] === undefined).map(ref),
      usage: usage.byModel(),
    };
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
    const current = this.store.resolveCluster(id);
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

/** A Cluster's name, or its first Task's title until the cheap model has named it. */
function clusterName(cluster: StoredCluster): string {
  return cluster.name ?? cluster.tasks[0]!.title;
}

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
