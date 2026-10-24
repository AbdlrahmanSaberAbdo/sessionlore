import type { Adapter, HarnessContext, HarnessId } from "./adapter.js";
import type { Clock, Embedder, ModelProvider } from "./ports.js";
import { resolveProject } from "./project.js";
import { splitIntoTasks, taskSplitPrompt } from "@sessionlore/analysis";
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
}

export interface HarnessScanResult {
  harness: HarnessId;
  name: string;
  added: number;
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

  close(): void {
    this.store.close();
  }

  /** Reads every Harness's storage into the store. Never writes to Harness storage. */
  async scan(): Promise<ScanResult> {
    const scanId = this.store.startScan(this.deps.clock.now());
    const harnesses: HarnessScanResult[] = [];
    for (const adapter of this.deps.adapters) {
      let added = 0;
      for (const storage of await adapter.discover(this.deps.harnessContext)) {
        for await (const source of adapter.listSessions(storage)) {
          const session = await adapter.readSession(source);
          if (!session) continue;
          const project = session.cwd ? resolveProject(session.cwd) : null;
          const result = this.store.saveSession({
            harness: adapter.harness,
            session,
            project,
            fingerprint: source.changeMarker,
            scanId,
          });
          if (result.added) added += 1;
        }
      }
      harnesses.push({ harness: adapter.harness, name: adapter.displayName, added });
    }
    this.store.finishScan(scanId, this.deps.clock.now());
    return { harnesses };
  }

  listSessions(): StoredSession[] {
    return this.store.listSessions();
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
    for (const session of this.store.sessionsToAnalyze()) {
      try {
        const tasks = await splitIntoTasks(modelProvider.cheap, session.userMessages);
        this.store.saveAnalysis(session.key, session.fingerprint, tasks);
        result.analyzed.push(session.id);
      } catch (error) {
        result.failed.push({ session: session.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  /** The redacted text Analysis would send for a Session, or null if no Session has that id. */
  redactedRequest(sessionId: string): string | null {
    const messages = this.store.sessionUserMessages(sessionId);
    return messages ? taskSplitPrompt(messages) : null;
  }

  listTasks(): SessionTasks[] {
    return this.store.listTasks();
  }
}
