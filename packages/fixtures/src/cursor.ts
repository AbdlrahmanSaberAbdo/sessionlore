import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { FixtureHome } from "./home.js";

/**
 * Builds a synthetic Cursor global `state.vscdb` (ADR 0002): the
 * `composerHeaders` table for Sessions and `cursorDiskKV` rows for
 * `composerData:<composerId>` and `bubbleId:<composerId>:<bubbleId>`, in WAL
 * mode like the database Cursor keeps open. All content is made up.
 */

export type CursorBubble =
  | { kind: "user"; text: string; wrapped: boolean; version?: number }
  | { kind: "assistant"; text: string; version?: number }
  | { kind: "tool"; name: string; status: string; toolCallId?: string; version?: number }
  | { kind: "thinking"; version?: number };

/** Bubbles of a Cursor composer, in conversation order. */
export const bubble = {
  /** Text the person typed. `wrapped` adds the `<timestamp>`/`<user_query>` tags newer Cursor versions store. */
  user: (text: string, options: { wrapped?: boolean; version?: number } = {}): CursorBubble => ({
    kind: "user",
    text,
    wrapped: options.wrapped ?? false,
    version: options.version,
  }),
  assistant: (text: string, options: { version?: number } = {}): CursorBubble => ({
    kind: "assistant",
    text,
    version: options.version,
  }),
  /** An agent tool call, e.g. `run_terminal_command_v2` or `task_v2` (which spawns a subagent). */
  tool: (name: string, status = "completed", options: { toolCallId?: string; version?: number } = {}): CursorBubble => ({
    kind: "tool",
    name,
    status,
    toolCallId: options.toolCallId,
    version: options.version,
  }),
  thinking: (): CursorBubble => ({ kind: "thinking" }),
};

export interface CursorComposerSpec {
  /** Folder the composer's workspace was opened on. */
  folder: string;
  /** ISO time of the first bubble. */
  createdAt: string;
  bubbles: CursorBubble[];
  /** Composer id; generated when omitted. */
  id?: string;
  model?: string;
  /** Seconds between consecutive bubbles. Defaults to 30. */
  stepSeconds?: number;
  /**
   * How the composer records its folder: in its header's `workspaceIdentifier`
   * (newer Cursor), or only through `workspaceStorage/<id>/workspace.json`.
   */
  workspaceMapping?: "header" | "workspace-json";
  /** Makes this a subagent composer spawned by `parentId`'s `task_v2` tool call `toolCallId`. */
  subagentOf?: { parentId: string; toolCallId: string; typeName?: string };
  /** composerData format version (`_v`). Defaults to 18. */
  composerVersion?: number;
}

export interface WrittenCursorDatabase {
  path: string;
  composerIds: string[];
}

const DEFAULT_MODEL = "claude-sonnet-5-5";
const BUBBLE_VERSION = 3;
const COMPOSER_VERSION = 18;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `00000000-0000-4000-9000-${counter.toString(16).padStart(12, "0")}`;
}

/** Cursor's `User` folder for the current platform. */
export function cursorUserDir(home: FixtureHome): string {
  return process.platform === "darwin"
    ? home.resolve(join("Library", "Application Support", "Cursor", "User"))
    : home.resolve(join(".config", "Cursor", "User"));
}

export function cursorDatabasePath(home: FixtureHome): string {
  return join(cursorUserDir(home), "globalStorage", "state.vscdb");
}

/** Writes (replacing any previous one) a Cursor database holding `composers`. */
export function writeCursorDatabase(home: FixtureHome, composers: CursorComposerSpec[]): WrittenCursorDatabase {
  const path = cursorDatabasePath(home);
  mkdirSync(dirname(path), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });

  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
      isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT
    );
    CREATE INDEX composerHeaders_workspace ON composerHeaders (workspaceId, isSubagent, isArchived, recency);
    CREATE INDEX composerHeaders_recency ON composerHeaders (recency, composerId);
  `);
  const kv = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  const header = db.prepare(
    `INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value, subagentTypeName)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  );

  const composerIds: string[] = [];
  for (const spec of composers) {
    const composerId = spec.id ?? nextId();
    composerIds.push(composerId);
    const step = (spec.stepSeconds ?? 30) * 1000;
    const createdAt = Date.parse(spec.createdAt);
    if (Number.isNaN(createdAt)) throw new Error(`Invalid createdAt: ${spec.createdAt}`);
    let clock = createdAt;
    const model = spec.model ?? DEFAULT_MODEL;

    const conversationHeaders: object[] = [];
    for (const b of spec.bubbles) {
      const bubbleId = nextId();
      const value = bubbleValue(b, bubbleId, clock, model);
      kv.run(`bubbleId:${composerId}:${bubbleId}`, JSON.stringify(value));
      conversationHeaders.push({ bubbleId, type: value.type, createdAt: value.createdAt });
      clock += step;
    }
    const lastUpdatedAt = clock - step;

    const workspaceId = workspaceIdFor(spec.folder);
    const uri = pathToFileURL(spec.folder);
    const workspaceIdentifier = {
      id: workspaceId,
      uri: { $mid: 1, fsPath: spec.folder, external: uri.href, path: uri.pathname, scheme: "file" },
    };
    if (spec.workspaceMapping === "workspace-json") {
      const dir = join(cursorUserDir(home), "workspaceStorage", workspaceId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "workspace.json"), JSON.stringify({ folder: uri.href }));
    }
    const subagentInfo = spec.subagentOf && {
      subagentType: 1,
      subagentTypeName: spec.subagentOf.typeName ?? "explore",
      parentComposerId: spec.subagentOf.parentId,
      rootParentConversationId: spec.subagentOf.parentId,
      toolCallId: spec.subagentOf.toolCallId,
      toolCallIdHistory: [spec.subagentOf.toolCallId],
    };

    header.run(
      composerId,
      workspaceId,
      createdAt,
      lastUpdatedAt,
      spec.subagentOf ? 1 : 0,
      lastUpdatedAt,
      lastUpdatedAt,
      JSON.stringify({
        type: "head",
        composerId,
        name: "",
        createdAt,
        lastUpdatedAt,
        unifiedMode: "agent",
        isDraft: false,
        ...(spec.workspaceMapping === "workspace-json" ? {} : { workspaceIdentifier }),
        ...(subagentInfo ? { subagentInfo } : {}),
      }),
      spec.subagentOf ? (spec.subagentOf.typeName ?? "explore") : null,
    );
    kv.run(
      `composerData:${composerId}`,
      JSON.stringify({
        _v: spec.composerVersion ?? COMPOSER_VERSION,
        composerId,
        name: "",
        status: "completed",
        createdAt,
        lastUpdatedAt,
        unifiedMode: "agent",
        isAgentic: true,
        fullConversationHeadersOnly: conversationHeaders,
        conversationMap: {},
        modelConfig: { modelName: model, maxMode: false },
        subagentComposerIds: composers
          .filter((c) => c.subagentOf?.parentId === composerId && c.id)
          .map((c) => c.id),
      }),
    );
  }
  db.close();
  return { path, composerIds };
}

/** Opens a writable connection to the Cursor database, as a running Cursor would hold it. */
export function holdCursorDatabaseOpen(home: FixtureHome): { close(): void } {
  const db = new DatabaseSync(cursorDatabasePath(home));
  db.exec("PRAGMA journal_mode = WAL; BEGIN; SELECT count(*) FROM composerHeaders;");
  return {
    close: () => {
      db.exec("COMMIT");
      db.close();
    },
  };
}

function bubbleValue(b: CursorBubble, bubbleId: string, at: number, model: string): Record<string, unknown> & { type: number; createdAt: string } {
  const createdAt = new Date(at).toISOString();
  const base = { _v: b.version ?? BUBBLE_VERSION, bubbleId, createdAt, requestId: nextId(), context: {}, images: [] };
  switch (b.kind) {
    case "user":
      return {
        ...base,
        type: 1,
        text: b.wrapped
          ? `<timestamp>Friday, May 1, 2026, 9:00 AM (UTC)</timestamp>\n<user_query>\n${b.text}\n</user_query>`
          : b.text,
        modelInfo: { modelName: model },
      };
    case "assistant":
      return { ...base, type: 2, text: b.text, capabilityType: null, toolFormerData: null, startedAtMs: at, completedAtMs: at };
    case "tool":
      return {
        ...base,
        type: 2,
        text: "",
        capabilityType: 15,
        toolFormerData: {
          name: b.name,
          tool: 1,
          toolCallId: b.toolCallId ?? `call_${nextId()}`,
          status: b.status,
          rawArgs: "{}",
          params: "{}",
          result: null,
        },
        startedAtMs: at,
        completedAtMs: at,
      };
    case "thinking":
      return { ...base, type: 2, text: "", capabilityType: 30, thinking: { text: "considering" }, toolFormerData: null };
  }
}

/** Cursor names workspaceStorage folders with an md5-like hex id; any stable hex id will do. */
function workspaceIdFor(folder: string): string {
  let hash = 0;
  for (const char of folder) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(32, "0");
}
