import type { Adapter, HarnessContext, HarnessId, SessionSource } from "./adapter.js";
import type { Clock, Embedder, ModelProvider } from "./ports.js";
import { ProjectFilter } from "./project-filter.js";
import { resolveProject } from "./project.js";
import { estimateTaskSplit, MalformedReplyError, splitIntoTasks, taskSplitPrompt, type TokenCount } from "@sessionlore/analysis";
import { costUsd, type Prices } from "./pricing.js";
import { Store, type SessionTasks, type StoredSession } from "./store/store.js";

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
  embedder?: Embedder;
  /** Which Projects may be stored and shown. Defaults to all of them. */
  projectFilter?: ProjectFilter;
  /** Model prices from the config, overriding the built-in ones. */
  prices?: Prices;
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
      counts.set(adapter, { added: 0, updated: 0, unchanged: 0 });
      unrecognized.set(adapter, new Map());
      for (const storage of await adapter.discover(this.deps.harnessContext)) {
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
    const interrupted = done < sessions.length;
    return { analyzed, failed, usage: usage.byModel(), interrupted, remaining: sessions.length - done };
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
