import type { Adapter, HarnessContext, HarnessId, SessionSource } from "./adapter.js";
import type { Clock, Embedder, ModelProvider } from "./ports.js";
import { resolveProject } from "./project.js";
import { Store, type StoredSession } from "./store/store.js";

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
  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const scanId = this.store.startScan(this.deps.clock.now());
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
      const tally = unrecognized.get(adapter)!;
      for (const [shape, n] of Object.entries(session.unrecognized)) tally.set(shape, (tally.get(shape) ?? 0) + n);
      const project = session.cwd ? resolveProject(session.cwd) : null;
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
    return this.store.listSessions();
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
