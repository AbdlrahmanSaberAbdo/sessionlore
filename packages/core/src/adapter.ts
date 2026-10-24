import type { Env } from "./ports.js";

/** Stable identifier of a Harness, used in the store and in `--json` output. */
export type HarnessId = "claude-code";

export interface HarnessContext {
  homeDir: string;
  env: Env;
}

/** One Session as found in Harness storage, before it is read. */
export interface SessionSource {
  /** The Harness's own id for the Session. */
  externalId: string;
  /** Where the Session lives (a file path, a database key, ...). Opaque to everything but its Adapter. */
  location: string;
  /** Changes whenever the Session's stored content changes; lets Scan skip unchanged Sessions. */
  changeMarker: string;
}

export interface HarnessUserMessage {
  text: string;
  timestamp: Date;
}

/** A Session read into the shape every Adapter produces. */
export interface HarnessSession {
  externalId: string;
  /** Working directory the Session ran in, if the Harness recorded one. */
  cwd: string | null;
  startedAt: Date;
  endedAt: Date;
  /** Only text the person typed; never agent, subagent or Harness-injected text. */
  userMessages: HarnessUserMessage[];
}

/**
 * Reads one Harness's storage during a Scan. Adapters only ever read:
 * they never write to Harness storage.
 */
export interface Adapter {
  readonly harness: HarnessId;
  /** Human-readable Harness name for CLI output, e.g. "Claude Code". */
  readonly displayName: string;
  /** Storage locations of this Harness that exist on this machine. */
  discover(ctx: HarnessContext): Promise<string[]>;
  listSessions(storage: string): AsyncIterable<SessionSource>;
  /** Returns null when the source holds no conversation (e.g. an empty file). */
  readSession(source: SessionSource): Promise<HarnessSession | null>;
}
