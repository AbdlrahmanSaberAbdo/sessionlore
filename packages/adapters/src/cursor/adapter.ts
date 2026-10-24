import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  openReadOnlyDatabase,
  type Adapter,
  type HarnessContext,
  type HarnessSession,
  type HarnessUserMessage,
  type ReadOnlyDatabase,
  type SessionSource,
} from "@sessionlore/core";

/**
 * Reads Cursor Sessions from its global `state.vscdb` (ADR 0002): one Session
 * per non-subagent row of `composerHeaders`, its messages from the
 * `composerData:<id>` and `bubbleId:<id>:<bubble>` keys of `cursorDiskKV`.
 * The database is always opened read-only.
 */
export const cursorAdapter: Adapter = {
  harness: "cursor",
  displayName: "Cursor",

  async discover(ctx: HarnessContext): Promise<string[]> {
    const configHome = ctx.env.XDG_CONFIG_HOME || join(ctx.homeDir, ".config");
    const candidates = [
      join(ctx.homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
      join(configHome, "Cursor", "User", "globalStorage", "state.vscdb"),
    ];
    return candidates.filter((path) => existsSync(path));
  },

  async *listSessions(database: string): AsyncIterable<SessionSource> {
    const headers = withDatabase(database, (db) =>
      db.all<{ composerId: string; lastUpdatedAt: number | bigint | null }>(
        "SELECT composerId, lastUpdatedAt FROM composerHeaders WHERE isSubagent IS NOT 1",
      ),
    );
    for (const header of headers) {
      yield {
        externalId: header.composerId,
        location: database,
        changeMarker: String(header.lastUpdatedAt ?? ""),
      };
    }
  },

  async readSession(source: SessionSource): Promise<HarnessSession | null> {
    return withDatabase(source.location, (db) => readComposer(db, source.externalId));
  },
};

type Json = Record<string, unknown>;

function withDatabase<T>(path: string, fn: (db: ReadOnlyDatabase) => T): T {
  const db = openReadOnlyDatabase(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readComposer(db: ReadOnlyDatabase, composerId: string): HarnessSession | null {
  const header = db.get<{ value: unknown }>("SELECT value FROM composerHeaders WHERE composerId = ?", composerId);
  const head = parseJson(header?.value);
  const data = parseJson(db.get<{ value: unknown }>("SELECT value FROM cursorDiskKV WHERE key = ?", `composerData:${composerId}`)?.value);
  if (!head || !data || head.isDraft === true) return null;

  const bubbles = readBubbles(db, composerId, data);
  const userMessages: HarnessUserMessage[] = [];
  let startedAt: Date | null = null;
  let endedAt: Date | null = null;
  for (const b of bubbles) {
    const timestamp = parseDate(b.createdAt);
    if (timestamp) {
      if (!startedAt || timestamp < startedAt) startedAt = timestamp;
      if (!endedAt || timestamp > endedAt) endedAt = timestamp;
    }
    if (b.type === 1 && timestamp) {
      const text = typedText(b.text);
      if (text) userMessages.push({ text, timestamp });
    }
  }
  if (!startedAt || !endedAt) return null;

  const modelConfig = data.modelConfig as Json | undefined;
  return {
    externalId: composerId,
    cwd: workspaceFolder(head),
    startedAt,
    endedAt,
    model: typeof modelConfig?.modelName === "string" ? modelConfig.modelName : null,
    userMessages,
  };
}

/** The composer's bubbles in conversation order, as listed in `fullConversationHeadersOnly`. */
function readBubbles(db: ReadOnlyDatabase, composerId: string, data: Json): Json[] {
  const order = Array.isArray(data.fullConversationHeadersOnly) ? (data.fullConversationHeadersOnly as Json[]) : [];
  const prefix = `bubbleId:${composerId}:`;
  // A key range (';' sorts right after ':') uses the key index; LIKE may not.
  const rows = db.all<{ key: string; value: unknown }>(
    "SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?",
    prefix,
    `bubbleId:${composerId};`,
  );
  const byId = new Map(rows.map((row) => [row.key.slice(prefix.length), row.value]));
  const bubbles: Json[] = [];
  for (const entry of order) {
    const value = parseJson(byId.get(String(entry.bubbleId)));
    if (value) bubbles.push(value);
  }
  return bubbles;
}

function workspaceFolder(head: Json): string | null {
  const identifier = head.workspaceIdentifier as { uri?: { fsPath?: unknown } } | undefined;
  return typeof identifier?.uri?.fsPath === "string" ? identifier.uri.fsPath : null;
}

/** What the person typed, without the `<timestamp>`/`<user_query>` wrapper newer Cursor versions add. */
function typedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const query = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/.exec(value);
  const text = (query ? query[1]! : value).trim();
  return text || null;
}

const decoder = new TextDecoder();

/** `cursorDiskKV` values are BLOB-declared but hold UTF-8 JSON text. */
function parseJson(value: unknown): Json | null {
  const text = value instanceof Uint8Array ? decoder.decode(value) : value;
  if (typeof text !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
