import type { Adapter, HarnessContext, HarnessId, SessionSource } from "./adapter.js";
import type { Clock, Embedder, ModelProvider } from "./ports.js";
import { ProjectFilter } from "./project-filter.js";
import { resolveProject } from "./project.js";
import {
  applyRepeatRule,
  defaultRepeatRule,
  nameCluster,
  placeTasks,
  splitIntoTasks,
  taskEmbeddingText,
  taskSplitPrompt,
  type RepeatRule,
} from "@sessionlore/analysis";
import {
  Store,
  type ClusterTask,
  type SessionTasks,
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

  /**
   * Splits every new or changed Session into Tasks and labels the Intent of
   * each User Message with the cheap model. A Session that fails is reported
   * and left for the next Analysis; the others still complete.
   */
  async analyze(): Promise<AnalysisResult> {
    const modelProvider = this.deps.modelProvider;
    if (!modelProvider) throw new Error("No Model Provider is configured.");
    const result: AnalysisResult = { analyzed: [], failed: [] };
    const sessions = this.store.sessionsToAnalyze().filter((s) => this.projectFilter.allows(s.project));
    for (const session of sessions) {
      try {
        const tasks = await splitIntoTasks(modelProvider.cheap, session.userMessages);
        this.store.saveAnalysis(session.key, session.fingerprint, tasks);
        result.analyzed.push(session.id);
      } catch (error) {
        result.failed.push({ session: session.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (this.deps.embedder) await this.clusterTasks(this.deps.embedder, modelProvider);
    return result;
  }

  private get repeatRule(): RepeatRule {
    return this.deps.repeatRule ?? defaultRepeatRule;
  }

  /**
   * Embeds Tasks locally, puts each new Task into the most similar Cluster or a
   * new one (ADR 0008), and names Clusters big enough to be shown. Tasks left
   * unclustered by an interruption are picked up by the next Analysis.
   */
  private async clusterTasks(embedder: Embedder, modelProvider: ModelProvider): Promise<void> {
    const toEmbed = this.store.tasksToEmbed(embedder.modelId);
    for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
      const batch = toEmbed.slice(i, i + EMBED_BATCH);
      const vectors = await embedder.embed(batch.map((t) => taskEmbeddingText(t.title, t.firstMessage)));
      this.store.saveEmbeddings(
        embedder.modelId,
        batch.map((t, j) => ({ key: t.key, vector: vectors[j]! })),
      );
    }
    const placements = placeTasks(
      this.store.clusterVectors(embedder.modelId),
      this.store.unclusteredTasks(embedder.modelId).map((t) => ({ task: t.key, vector: t.vector })),
    );
    this.store.placeTasks(placements, this.deps.clock.now());

    // A Cluster can only be listed once it has this many Tasks, so smaller ones need no name yet.
    const showable = Math.min(NEAR_WORKFLOW_MIN_TASKS, this.repeatRule.minMembers);
    for (const cluster of this.store.unnamedClusters(showable)) {
      try {
        this.store.nameCluster(cluster.id, await nameCluster(modelProvider.cheap, cluster.taskTitles));
      } catch {
        // Left unnamed and retried by the next Analysis; listings fall back to a Task title meanwhile.
      }
    }
  }

  /** Clusters that pass the Repeat Rule now, and those close to passing. */
  listWorkflows(): WorkflowsResult {
    const rule = this.repeatRule;
    const now = this.deps.clock.now();
    const result: WorkflowsResult = { repeatRule: rule, workflows: [], nearWorkflows: [] };
    for (const cluster of this.store.listClusters()) {
      const tasks = cluster.tasks.filter((t) =>
        this.projectFilter.allows(t.project && { root: t.project.path, name: t.project.name }),
      );
      if (tasks.length === 0) continue;
      const verdict = applyRepeatRule(
        tasks.map((t) => ({ session: t.session, at: new Date(t.at) })),
        rule,
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
