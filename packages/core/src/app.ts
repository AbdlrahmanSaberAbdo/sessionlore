import type { Adapter, HarnessContext, HarnessId, ScanWarnings } from "./adapter.js";
import type { Clock, Embedder, ModelProvider } from "./ports.js";
import { resolveProject } from "./project.js";
import { Store, type StoredSession, type StoredSessionDetail } from "./store/store.js";

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
  /** Sessions already in the store whose content changed since the last Scan. */
  updated: number;
  /** Storage the Adapter did not fully understand, with how many items each warning covers. */
  warnings: ScanWarning[];
}

export interface ScanWarning {
  message: string;
  count: number;
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
  async scan(): Promise<ScanResult> {
    const scanId = this.store.startScan(this.deps.clock.now());
    const harnesses: HarnessScanResult[] = [];
    for (const adapter of this.deps.adapters) {
      const storages = await adapter.discover(this.deps.harnessContext);
      if (storages.length === 0) continue; // this Harness has no data on this machine
      let added = 0;
      let updated = 0;
      const counts = new Map<string, number>();
      const warnings: ScanWarnings = { warn: (message) => counts.set(message, (counts.get(message) ?? 0) + 1) };
      for (const storage of storages) {
        for await (const source of adapter.listSessions(storage, warnings)) {
          // Incremental: a Session whose change marker is unchanged is not read again.
          if (this.store.sessionFingerprint(adapter.harness, source.externalId) === source.changeMarker) continue;
          const session = await adapter.readSession(source, warnings);
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
          else updated += 1;
        }
      }
      harnesses.push({
        harness: adapter.harness,
        name: adapter.displayName,
        added,
        updated,
        warnings: [...counts].map(([message, count]) => ({ message, count })),
      });
    }
    this.store.finishScan(scanId, this.deps.clock.now());
    return { harnesses };
  }

  listSessions(): StoredSession[] {
    return this.store.listSessions();
  }

  getSession(id: string): StoredSessionDetail | null {
    return this.store.getSession(id);
  }
}
