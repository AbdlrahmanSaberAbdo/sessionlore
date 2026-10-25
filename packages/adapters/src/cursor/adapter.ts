import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openReadOnlyDatabase,
  type Adapter,
  type HarnessContext,
  type HarnessMessage,
  type HarnessSession,
  type HarnessUserMessage,
  type ReadOnlyDatabase,
  type SessionSource,
  type TokenUsage,
} from "@sessionlore/core";

/**
 * Reads Cursor Sessions from its global `state.vscdb` (ADR 0002): one Session
 * per non-subagent row of `composerHeaders` (or, in a database without that
 * table, per entry of the older `composer.composerData` list in `ItemTable`),
 * its messages from the `composerData:<id>` and `bubbleId:<id>:<bubble>` keys
 * of `cursorDiskKV`. The database is always opened read-only.
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

  async *listSessions(database: string, warn?: (text: string) => void): AsyncIterable<SessionSource> {
    const { layout, headers } = withDatabase(database, (db) => {
      const layout = headerLayout(db);
      return { layout, headers: layout === "none" ? [] : allHeaders(db, layout) };
    });
    if (layout === "legacy") {
      warn?.(
        `Cursor: ${database} has no composerHeaders table, so its Sessions were read from the older composer list. ` +
          "Some Sessions may have no Project; if this Cursor is current, please report this so sessionlore can read it.",
      );
    } else if (layout === "none") {
      warn?.(
        `Cursor: ${database} has neither a composerHeaders table nor the older composer list, so no Cursor Sessions were read. ` +
          "Cursor may have changed its storage format; please report this so sessionlore can read it.",
      );
    }
    // A Session changes when its composer or any of its subagent composers does.
    const updates = new Map<string, { markers: string[]; lastActivity: number }>();
    const roots: string[] = [];
    for (const header of headers) {
      const owner = header.isSubagent ? rootParentOf(header.head) : header.composerId;
      if (!owner) continue; // a subagent whose parent is unknown is not a Session of its own
      if (owner === header.composerId) roots.push(owner);
      const group = updates.get(owner) ?? { markers: [], lastActivity: 0 };
      group.markers.push(`${header.composerId}@${header.lastUpdatedAt ?? ""}`);
      group.lastActivity = Math.max(group.lastActivity, header.lastUpdatedAt ?? 0);
      updates.set(owner, group);
    }
    for (const composerId of roots) {
      const group = updates.get(composerId)!;
      yield {
        externalId: composerId,
        location: database,
        changeMarker: group.markers.sort().join(","),
        lastActivityAt: new Date(group.lastActivity),
      };
    }
  },

  async readSession(source: SessionSource): Promise<HarnessSession | null> {
    return withDatabase(source.location, (db) => {
      const layout = headerLayout(db);
      if (layout === "none") return null;
      return readComposer({ db, layout, database: source.location, unrecognized: {}, tokens: emptyUsage() }, source.externalId);
    });
  },
};

/** Highest `_v` of `composerData:*` values this Adapter was written against. */
const KNOWN_COMPOSER_VERSION = 18;
/** Highest `_v` of `bubbleId:*` values this Adapter was written against. */
const KNOWN_BUBBLE_VERSION = 3;

type Json = Record<string, unknown>;
/** How node:sqlite returns a BLOB-declared column. */
type SqlBlob = string | Uint8Array | null;

/** A message plus, for tool calls, the call id a subagent composer points back to. */
interface ThreadEntry {
  message: HarnessMessage;
  toolCallId: string | null;
}

interface Reader {
  db: ReadOnlyDatabase;
  /** Where the composers' headers are. */
  layout: HeaderLayout;
  /** Path of the `state.vscdb` being read. */
  database: string;
  /** What was skipped or not fully understood, by shape (see `HarnessSession.unrecognized`). */
  unrecognized: Record<string, number>;
  /** Tokens of every bubble read, subagents' included. */
  tokens: TokenUsage;
}

interface SubagentHeader {
  composerId: string;
  typeName: string;
  toolCallId: string | null;
}

/**
 * Where a database keeps its composers' headers: the `composerHeaders` table,
 * the older `composer.composerData` list in `ItemTable`, or neither.
 */
type HeaderLayout = "table" | "legacy" | "none";

/** A composer's header, wherever the database keeps it. */
interface ComposerHeader {
  composerId: string;
  /** Cursor's id for the workspace it was opened in; null in the older composer list. */
  workspaceId: string | null;
  lastUpdatedAt: number | null;
  createdAt: number | null;
  isSubagent: boolean;
  subagentTypeName: string | null;
  head: Json | null;
}

const LEGACY_HEADERS_KEY = "composer.composerData";

function headerLayout(db: ReadOnlyDatabase): HeaderLayout {
  const tables = new Set(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name));
  if (tables.has("composerHeaders")) return "table";
  if (tables.has("ItemTable") && db.get("SELECT 1 FROM ItemTable WHERE key = ?", LEGACY_HEADERS_KEY)) return "legacy";
  return "none";
}

function allHeaders(db: ReadOnlyDatabase, layout: Exclude<HeaderLayout, "none">): ComposerHeader[] {
  if (layout === "legacy") {
    const list = parseJson(db.get<{ value: SqlBlob }>("SELECT value FROM ItemTable WHERE key = ?", LEGACY_HEADERS_KEY)?.value);
    const composers = Array.isArray(list?.allComposers) ? (list.allComposers as unknown[]) : [];
    return composers.flatMap((value): ComposerHeader[] => {
      const head = value && typeof value === "object" ? (value as Json) : null;
      if (typeof head?.composerId !== "string") return [];
      const info = head.subagentInfo as Json | undefined;
      const time = (v: unknown) => (typeof v === "number" ? v : null);
      return [
        {
          composerId: head.composerId,
          workspaceId: null,
          lastUpdatedAt: time(head.lastUpdatedAt),
          createdAt: time(head.createdAt),
          isSubagent: info !== undefined,
          subagentTypeName: typeof info?.subagentTypeName === "string" ? info.subagentTypeName : null,
          head,
        },
      ];
    });
  }
  return db
    .all<{
      composerId: string;
      workspaceId: string | null;
      lastUpdatedAt: number | bigint | null;
      createdAt: number | bigint | null;
      isSubagent: number | bigint | null;
      subagentTypeName: string | null;
      value: SqlBlob;
    }>("SELECT composerId, workspaceId, lastUpdatedAt, createdAt, isSubagent, subagentTypeName, value FROM composerHeaders")
    .map((row) => ({
      composerId: row.composerId,
      workspaceId: row.workspaceId,
      lastUpdatedAt: row.lastUpdatedAt === null ? null : Number(row.lastUpdatedAt),
      createdAt: row.createdAt === null ? null : Number(row.createdAt),
      isSubagent: Number(row.isSubagent) === 1,
      subagentTypeName: row.subagentTypeName,
      head: parseJson(row.value),
    }));
}

/** One composer's header. The table is queried by id; the older list is small enough to search. */
function headerOf(reader: Reader, composerId: string): ComposerHeader | null {
  if (reader.layout === "legacy") return allHeaders(reader.db, "legacy").find((h) => h.composerId === composerId) ?? null;
  const row = reader.db.get<{ workspaceId: string | null; value: SqlBlob }>(
    "SELECT workspaceId, value FROM composerHeaders WHERE composerId = ?",
    composerId,
  );
  if (!row) return null;
  return { composerId, workspaceId: row.workspaceId, lastUpdatedAt: null, createdAt: null, isSubagent: false, subagentTypeName: null, head: parseJson(row.value) };
}

function withDatabase<T>(path: string, fn: (db: ReadOnlyDatabase) => T): T {
  const db = openReadOnlyDatabase(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readComposer(reader: Reader, composerId: string): HarnessSession | null {
  const header = headerOf(reader, composerId);
  const head = header?.head ?? null;
  const data = readComposerData(reader, composerId);
  if (!head || !data || head.isDraft === true) return null;

  const seen = new Set([composerId]);
  const messages = readThread(reader, composerId, data, null, seen);
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
  if (Object.keys(reader.unrecognized).length > 0) {
    // Keep the Session even if nothing in it could be read, so its warning is not lost with it.
    startedAt ??= parseDate(head.createdAt);
    endedAt ??= parseDate(head.lastUpdatedAt) ?? startedAt;
  }
  if (!startedAt || !endedAt) return null;

  const modelConfig = data.modelConfig as Json | undefined;
  return {
    externalId: composerId,
    cwd: workspaceFolder(head) ?? mappedWorkspaceFolder(reader.database, header?.workspaceId ?? null),
    startedAt,
    endedAt,
    model: typeof modelConfig?.modelName === "string" ? modelConfig.modelName : null,
    userMessages,
    messages,
    // Cursor has no API message ids; each visible assistant bubble of the conversation is one reply.
    assistantTurnCount: messages.filter((m) => m.role === "assistant" && !m.subagent).length,
    subagentRunCount: seen.size - 1,
    tokens: reader.tokens,
    unrecognized: reader.unrecognized,
  };
}

function readComposerData(reader: Reader, composerId: string): Json | null {
  const data = parseJson(
    reader.db.get<{ value: SqlBlob }>("SELECT value FROM cursorDiskKV WHERE key = ?", `composerData:${composerId}`)?.value,
  );
  // A composer is the Session itself, so a newer one is still read (and reported); its bubbles are checked one by one.
  const version = unknownVersion(data, KNOWN_COMPOSER_VERSION);
  if (version !== null) count(reader, `composer format version ${version}, read as best possible`);
  return data;
}

/** The `_v` of a value if it is newer than this Adapter knows, else null. */
function unknownVersion(value: Json | null, known: number): number | null {
  const version = value?._v;
  return typeof version === "number" && version > known ? version : null;
}

function count(reader: Reader, shape: string): void {
  reader.unrecognized[shape] = (reader.unrecognized[shape] ?? 0) + 1;
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

function addTokens(reader: Reader, bubble: Json): void {
  const usage = bubble.tokenCount as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
  const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  reader.tokens.input += n(usage?.inputTokens);
  reader.tokens.output += n(usage?.outputTokens);
}

/**
 * A composer's messages, with each subagent composer it spawned folded in right
 * after the tool call that started it. Inside a subagent `subagent` is set, and
 * its type-1 bubbles count as assistant text: the parent agent wrote them, not the person.
 */
function readThread(reader: Reader, composerId: string, data: Json, subagent: string | null, seen: Set<string>): HarnessMessage[] {
  const children = subagentsOf(reader, composerId).filter((child) => !seen.has(child.composerId));
  const childThread = (child: SubagentHeader): HarnessMessage[] => {
    seen.add(child.composerId);
    const childData = readComposerData(reader, child.composerId);
    return childData ? readThread(reader, child.composerId, childData, child.typeName, seen) : [];
  };

  const messages: HarnessMessage[] = [];
  for (const b of readBubbles(reader, composerId, data)) {
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

function subagentsOf(reader: Reader, composerId: string): SubagentHeader[] {
  const rows =
    reader.layout === "legacy"
      ? allHeaders(reader.db, "legacy")
          .filter((h) => h.isSubagent && (h.head?.subagentInfo as Json | undefined)?.parentComposerId === composerId)
          .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      : reader.db
          .all<{ composerId: string; subagentTypeName: string | null; value: SqlBlob }>(
            `SELECT composerId, subagentTypeName, value FROM composerHeaders
              WHERE isSubagent = 1 AND json_extract(value, '$.subagentInfo.parentComposerId') = ?
              ORDER BY createdAt`,
            composerId,
          )
          .map((row) => ({ composerId: row.composerId, subagentTypeName: row.subagentTypeName, head: parseJson(row.value) }));
  return rows.map((row) => {
    const info = (row.head?.subagentInfo ?? {}) as Json;
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
function readBubbles(reader: Reader, composerId: string, data: Json): Json[] {
  const order = Array.isArray(data.fullConversationHeadersOnly) ? (data.fullConversationHeadersOnly as Json[]) : [];
  const prefix = `bubbleId:${composerId}:`;
  // A key range (';' sorts right after ':') uses the key index; LIKE may not.
  const rows = reader.db.all<{ key: string; value: SqlBlob }>(
    "SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?",
    prefix,
    `bubbleId:${composerId};`,
  );
  const byId = new Map(rows.map((row) => [row.key.slice(prefix.length), row.value]));
  const bubbles: Json[] = [];
  for (const entry of order) {
    const value = parseJson(byId.get(String(entry.bubbleId)));
    if (!value) continue;
    const version = unknownVersion(value, KNOWN_BUBBLE_VERSION);
    if (version !== null) {
      count(reader, `bubble format version ${version}`);
      continue;
    }
    addTokens(reader, value);
    bubbles.push(value);
  }
  return bubbles;
}

function workspaceFolder(head: Json): string | null {
  const identifier = head.workspaceIdentifier as { uri?: { fsPath?: unknown } } | undefined;
  return typeof identifier?.uri?.fsPath === "string" ? identifier.uri.fsPath : null;
}

/**
 * The folder Cursor's workspace mapping gives a workspace id:
 * `User/workspaceStorage/<workspaceId>/workspace.json`, next to `User/globalStorage`.
 * It names the folder, or for a multi-root workspace the `.code-workspace`
 * file, whose first folder is the Session's (Scan resolves it to its Project).
 */
function mappedWorkspaceFolder(database: string, workspaceId: string | null): string | null {
  if (!workspaceId) return null;
  const file = join(dirname(dirname(database)), "workspaceStorage", workspaceId, "workspace.json");
  if (!existsSync(file)) return null;
  const mapping = parseJson(readFileSync(file, "utf8"));
  if (typeof mapping?.folder === "string") return filePath(mapping.folder);
  if (typeof mapping?.workspace === "string") {
    const workspaceFile = filePath(mapping.workspace);
    return workspaceFile ? firstWorkspaceFolder(workspaceFile) : null;
  }
  return null;
}

/** The first folder a `.code-workspace` file lists, resolved against the file's own folder. */
function firstWorkspaceFolder(workspaceFile: string): string | null {
  if (!existsSync(workspaceFile)) return null;
  const workspace = parseJson(stripJsonComments(readFileSync(workspaceFile, "utf8")));
  const folders = Array.isArray(workspace?.folders) ? (workspace.folders as { path?: unknown; uri?: unknown }[]) : [];
  for (const folder of folders) {
    if (typeof folder?.path === "string") return resolve(dirname(workspaceFile), folder.path);
    if (typeof folder?.uri === "string") {
      const path = filePath(folder.uri);
      if (path) return path;
    }
  }
  return null;
}

/** The local path of a `file:` URL, or null for anything else. */
function filePath(url: string): string | null {
  if (!url.startsWith("file:")) return null;
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/** `.code-workspace` files are JSON with comments and trailing commas; this leaves plain JSON. */
function stripJsonComments(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const string = end.exec(text)?.[0] ?? text.slice(i);
      result += string;
      i += string.length - 1;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      result += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 1;
    } else {
      result += char;
    }
  }
  return result.replace(/,(\s*[}\]])/g, "$1");
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
