import type { Env } from "./ports.js";

/** Stable identifier of a Harness, used in the store and in `--json` output. */
export type HarnessId = "claude-code" | "cursor";

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
  /** When the Session was last written to, as far as storage tells without reading it. Orders `scan --last N`. */
  lastActivityAt: Date;
}

export interface HarnessUserMessage {
  text: string;
  timestamp: Date;
}

/** Tokens the Session's model calls used, each API message counted once. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/**
 * One message of a Session, in the order it happened: something the person typed,
 * visible assistant text, or a tool call the agent made.
 */
export type HarnessMessage = (
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool"; name: string; status: string | null }
) & {
  timestamp: Date | null;
  /** Set on messages from a subagent run inside the Session: the subagent's type, e.g. "explore". */
  subagent?: string;
};

/** The agent loading a Skill during a Session, e.g. through Claude Code's Skill tool. */
export interface HarnessSkillUse {
  /** The name the Skill was invoked by, e.g. `write-a-migration` or `plugin:name`. */
  name: string;
  /** The folder the Skill was loaded from, if the Harness recorded it. */
  baseDir: string | null;
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
  /** Assistant replies in the Session, one per API message however the Harness splits it. */
  assistantTurnCount: number;
  /** Subagent runs started inside the Session; they belong to it, and their tokens are in `tokens`. */
  subagentRunCount: number;
  /** Tokens of the Session and its subagent runs. */
  tokens: TokenUsage;
  /**
   * Records the Adapter did not recognise and skipped, counted by a short
   * description of their shape (e.g. `record type "foo"`). Scan turns these into
   * a visible warning, so a Harness format change never silently drops data (ADR 0001).
   */
  unrecognized: Record<string, number>;
  /** The model the Session ran with, if the Harness recorded one. */
  model?: string | null;
  /** Every message of the Session in order, for Harnesses whose Adapter reads them. */
  messages?: HarnessMessage[];
  /** Skills the agent loaded, in order, for Harnesses that have Skills. */
  skillUses?: HarnessSkillUse[];
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
  /** `warn` reports a problem the person should know about, such as storage laid out in a way the Adapter does not know. */
  listSessions(storage: string, warn?: (text: string) => void): AsyncIterable<SessionSource>;
  /** Returns null when the source holds no Session (e.g. an empty file). */
  readSession(source: SessionSource): Promise<HarnessSession | null>;
}
