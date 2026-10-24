import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  openReadOnlyDatabase,
  type Adapter,
  type HarnessContext,
  type HarnessMessage,
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
      db.all<{ composerId: string; lastUpdatedAt: number | bigint | null; isSubagent: number | bigint | null; value: SqlBlob }>(
        "SELECT composerId, lastUpdatedAt, isSubagent, value FROM composerHeaders",
      ),
    );
    // A Session changes when its composer or any of its subagent composers does.
    const updates = new Map<string, string[]>();
    const roots: string[] = [];
    for (const header of headers) {
      const owner = Number(header.isSubagent) === 1 ? rootParentOf(parseJson(header.value)) : header.composerId;
      if (!owner) continue; // a subagent whose parent is unknown is not a Session of its own
      if (owner === header.composerId) roots.push(owner);
      updates.set(owner, [...(updates.get(owner) ?? []), `${header.composerId}@${String(header.lastUpdatedAt ?? "")}`]);
    }
    for (const composerId of roots) {
      yield { externalId: composerId, location: database, changeMarker: (updates.get(composerId) ?? []).sort().join(",") };
    }
  },

  async readSession(source: SessionSource): Promise<HarnessSession | null> {
    return withDatabase(source.location, (db) => readComposer(db, source.externalId));
  },
};

type Json = Record<string, unknown>;
/** How node:sqlite returns a BLOB-declared column. */
type SqlBlob = string | Uint8Array | null;

/** A message plus, for tool calls, the call id a subagent composer points back to. */
interface ThreadEntry {
  message: HarnessMessage;
  toolCallId: string | null;
}

interface SubagentHeader {
  composerId: string;
  typeName: string;
  toolCallId: string | null;
}

function withDatabase<T>(path: string, fn: (db: ReadOnlyDatabase) => T): T {
  const db = openReadOnlyDatabase(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readComposer(db: ReadOnlyDatabase, composerId: string): HarnessSession | null {
  const head = parseJson(db.get<{ value: SqlBlob }>("SELECT value FROM composerHeaders WHERE composerId = ?", composerId)?.value);
  const data = readComposerData(db, composerId);
  if (!head || !data || head.isDraft === true) return null;

  const messages = readThread(db, composerId, data, null, new Set([composerId]));
  const userMessages: HarnessUserMessage[] = [];
  let startedAt: Date | null = null;
  let endedAt: Date | null = null;
  for (const message of messages) {
    const timestamp = message.timestamp;
    if (timestamp) {
      if (!startedAt || timestamp < startedAt) startedAt = timestamp;
      if (!endedAt || timestamp > endedAt) endedAt = timestamp;
    }
    if (message.role === "user" && timestamp) userMessages.push({ text: message.text, timestamp });
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
    messages,
  };
}

function readComposerData(db: ReadOnlyDatabase, composerId: string): Json | null {
  return parseJson(db.get<{ value: SqlBlob }>("SELECT value FROM cursorDiskKV WHERE key = ?", `composerData:${composerId}`)?.value);
}

/**
 * A composer's messages, with each subagent composer it spawned folded in right
 * after the tool call that started it. Inside a subagent `subagent` is set, and
 * its type-1 bubbles count as assistant text: the parent agent wrote them, not the person.
 */
function readThread(db: ReadOnlyDatabase, composerId: string, data: Json, subagent: string | null, seen: Set<string>): HarnessMessage[] {
  const children = subagentsOf(db, composerId).filter((child) => !seen.has(child.composerId));
  const childThread = (child: SubagentHeader): HarnessMessage[] => {
    seen.add(child.composerId);
    const childData = readComposerData(db, child.composerId);
    return childData ? readThread(db, child.composerId, childData, child.typeName, seen) : [];
  };

  const messages: HarnessMessage[] = [];
  for (const b of readBubbles(db, composerId, data)) {
    const entry = toEntry(b, subagent);
    if (!entry) continue;
    messages.push(entry.message);
    if (!entry.toolCallId) continue;
    for (const child of children) {
      if (child.toolCallId === entry.toolCallId && !seen.has(child.composerId)) messages.push(...childThread(child));
    }
  }
  // Subagents whose spawning tool call was not found still belong to the Session.
  for (const child of children) if (!seen.has(child.composerId)) messages.push(...childThread(child));
  return messages;
}

function subagentsOf(db: ReadOnlyDatabase, composerId: string): SubagentHeader[] {
  const rows = db.all<{ composerId: string; subagentTypeName: string | null; value: SqlBlob }>(
    `SELECT composerId, subagentTypeName, value FROM composerHeaders
      WHERE isSubagent = 1 AND json_extract(value, '$.subagentInfo.parentComposerId') = ?
      ORDER BY createdAt`,
    composerId,
  );
  return rows.map((row) => {
    const info = (parseJson(row.value)?.subagentInfo ?? {}) as Json;
    const typeName = row.subagentTypeName || (typeof info.subagentTypeName === "string" ? info.subagentTypeName : "");
    return {
      composerId: row.composerId,
      typeName: typeName || "subagent",
      toolCallId: typeof info.toolCallId === "string" ? info.toolCallId : null,
    };
  });
}

/** The top-level composer a subagent composer belongs to. */
function rootParentOf(head: Json | null): string | null {
  const info = head?.subagentInfo as Json | undefined;
  const root = info?.rootParentConversationId || info?.parentComposerId;
  return typeof root === "string" && root ? root : null;
}

/** A bubble as a thread entry, or null for bubbles with nothing to show (thinking, empty steps). */
function toEntry(b: Json, subagent: string | null): ThreadEntry | null {
  const timestamp = parseDate(b.createdAt);
  const tag = subagent ? { subagent } : {};
  if (b.type === 1) {
    const text = typedText(b.text);
    if (!text) return null;
    return { message: { role: subagent ? "assistant" : "user", text, timestamp, ...tag }, toolCallId: null };
  }
  if (b.type !== 2) return null;
  const tool = b.toolFormerData as { name?: unknown; status?: unknown; toolCallId?: unknown } | null | undefined;
  if (tool && typeof tool.name === "string") {
    const status = typeof tool.status === "string" ? tool.status : null;
    return {
      message: { role: "tool", name: tool.name, status, timestamp, ...tag },
      toolCallId: typeof tool.toolCallId === "string" ? tool.toolCallId : null,
    };
  }
  const text = typeof b.text === "string" ? b.text.trim() : "";
  return text ? { message: { role: "assistant", text, timestamp, ...tag }, toolCallId: null } : null;
}

/** The composer's bubbles in conversation order, as listed in `fullConversationHeadersOnly`. */
function readBubbles(db: ReadOnlyDatabase, composerId: string, data: Json): Json[] {
  const order = Array.isArray(data.fullConversationHeadersOnly) ? (data.fullConversationHeadersOnly as Json[]) : [];
  const prefix = `bubbleId:${composerId}:`;
  // A key range (';' sorts right after ':') uses the key index; LIKE may not.
  const rows = db.all<{ key: string; value: SqlBlob }>(
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
