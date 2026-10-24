import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type {
  Adapter,
  HarnessContext,
  HarnessSession,
  HarnessUserMessage,
  SessionSource,
  TokenUsage,
} from "@sessionlore/core";

/**
 * Reads Claude Code's per-project JSONL Session files:
 * `<config dir>/projects/<encoded cwd>/<session id>.jsonl`, where the config
 * dir is `$CLAUDE_CONFIG_DIR` or `~/.claude`. Subagent runs started in a
 * Session are in `<session id>/subagents/agent-<agent id>.jsonl` next to it and
 * belong to that Session. Files are only ever opened for reading.
 */
/**
 * Part of every change marker, so Sessions are read again after a sessionlore
 * update changes what this Adapter reads from them. Bump it when that happens.
 */
const READER_VERSION = "claude-code-reader-2";

export const claudeCodeAdapter: Adapter = {
  harness: "claude-code",
  displayName: "Claude Code",

  async discover(ctx: HarnessContext): Promise<string[]> {
    const configDir = ctx.env.CLAUDE_CONFIG_DIR || join(ctx.homeDir, ".claude");
    const projectsDir = join(configDir, "projects");
    return existsSync(projectsDir) ? [projectsDir] : [];
  },

  async *listSessions(projectsDir: string): AsyncIterable<SessionSource> {
    for (const projectEntry of await readdir(projectsDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue;
      const projectDir = join(projectsDir, projectEntry.name);
      for (const entry of await readdir(projectDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const location = join(projectDir, entry.name);
        const files = [location, ...(await subagentFiles(location))];
        const infos = await Promise.all(files.map((file) => stat(file)));
        yield {
          externalId: basename(entry.name, ".jsonl"),
          location,
          changeMarker: [READER_VERSION, ...infos.map((info) => `${info.size}:${info.mtimeMs}`)].join(","),
          lastActivityAt: new Date(Math.max(...infos.map((info) => info.mtimeMs))),
        };
      }
    }
  },

  async readSession(source: SessionSource): Promise<HarnessSession | null> {
    let cwd: string | null = null;
    let startedAt: Date | null = null;
    let endedAt: Date | null = null;
    const userMessages: HarnessUserMessage[] = [];
    const main = new AssistantMessages();
    const tree = new MessageTree();
    const unrecognized: Record<string, number> = {};

    for await (const record of readRecords(source.location)) {
      countUnrecognized(record, unrecognized);
      tree.add(record);
      if (!isConversation(record)) continue;
      const timestamp = parseTimestamp(record.timestamp);
      if (timestamp) {
        if (!startedAt || timestamp < startedAt) startedAt = timestamp;
        if (!endedAt || timestamp > endedAt) endedAt = timestamp;
      }
      if (!cwd && typeof record.cwd === "string") cwd = record.cwd;
    }
    if (!startedAt || !endedAt) return null;

    for (const record of tree.activeBranch()) {
      if (record.type === "assistant") main.add(record);
      const timestamp = parseTimestamp(record.timestamp);
      if (record.type === "user" && timestamp) {
        const text = typedUserText(record);
        if (text !== null) userMessages.push({ text, timestamp });
      }
    }

    // A subagent's records are all written by agents, never by the person: only its token usage counts.
    const subagents = await subagentFiles(source.location);
    const subagentUsage = new AssistantMessages();
    for (const file of subagents) {
      for await (const record of readRecords(file)) {
        countUnrecognized(record, unrecognized);
        if (record.type === "assistant") subagentUsage.add(record);
      }
    }

    return {
      externalId: source.externalId,
      cwd,
      startedAt,
      endedAt,
      userMessages,
      model: main.model,
      assistantTurnCount: main.count,
      subagentRunCount: subagents.length,
      tokens: sumUsage([main.tokens, subagentUsage.tokens]),
      unrecognized,
    };
  },
};

type JsonRecord = Record<string, unknown>;

/**
 * Every record type Claude Code is known to write. Only `user` and `assistant`
 * carry the conversation; the rest are metadata sessionlore does not need.
 * Anything else is counted and reported, never silently skipped (ADR 0001).
 */
const KNOWN_RECORD_TYPES = new Set([
  "user",
  "assistant",
  "attachment",
  "system",
  "summary",
  "progress",
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "queue-operation",
  "last-prompt",
  "custom-title",
  "ai-title",
  "agent-name",
  "atis-latch",
  "mode",
  "permission-mode",
  "file-history-snapshot",
  "file-history-delta",
  "cost-state",
  "pr-link",
]);

function countUnrecognized(record: JsonRecord, tally: Record<string, number>): void {
  const type = record.type;
  if (typeof type === "string" && KNOWN_RECORD_TYPES.has(type)) return;
  const shape = typeof type === "string" ? `record type ${JSON.stringify(type)}` : "record without a type";
  tally[shape] = (tally[shape] ?? 0) + 1;
}

function isConversation(record: JsonRecord): boolean {
  return (record.type === "user" || record.type === "assistant") && record.isSidechain !== true;
}

/**
 * Claude Code records form a tree through `parentUuid`: editing an earlier
 * message, rewinding or retrying starts a new branch, and the abandoned
 * branch stays in the file. The conversation is the branch that ends at the
 * last conversation record written, followed back to its root.
 */
class MessageTree {
  /** Every record with a uuid; non-conversation ones only as links in the chain. */
  private readonly byUuid = new Map<string, JsonRecord>();
  private readonly inFileOrder: JsonRecord[] = [];
  private leaf: JsonRecord | null = null;

  add(record: JsonRecord): void {
    const conversation = isConversation(record);
    if (conversation) this.inFileOrder.push(record);
    if (typeof record.uuid !== "string") return;
    // Only keep what following the chain needs; other records (e.g. API request snapshots) can be large.
    this.byUuid.set(
      record.uuid,
      conversation ? record : { parentUuid: record.parentUuid, logicalParentUuid: record.logicalParentUuid },
    );
    if (conversation) this.leaf = record;
  }

  /** The conversation records of the active branch, oldest first. */
  activeBranch(): JsonRecord[] {
    // Records without uuids (very old or unusual files) can't be followed; fall back to file order.
    if (!this.leaf) return this.inFileOrder;
    const branch: JsonRecord[] = [];
    const seen = new Set<string>();
    let current: JsonRecord | undefined = this.leaf;
    while (current) {
      if (isConversation(current)) branch.push(current);
      // A compaction boundary has no parentUuid but points at the pre-compaction conversation logically.
      const parent: unknown = current.parentUuid ?? current.logicalParentUuid;
      if (typeof parent !== "string" || seen.has(parent)) break;
      seen.add(parent);
      current = this.byUuid.get(parent);
    }
    return branch.reverse();
  }
}

/** Transcripts of the subagent runs started in the Session stored at `sessionFile`. */
async function subagentFiles(sessionFile: string): Promise<string[]> {
  const dir = join(sessionFile.slice(0, -".jsonl".length), "subagents");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

async function* readRecords(file: string): AsyncIterable<JsonRecord> {
  const lines = createInterface({ input: createReadStream(file, { flags: "r" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object") yield parsed as JsonRecord;
    } catch {
      // A partially written last line; the next Scan will read it once complete.
    }
  }
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The assistant API messages of one transcript. Claude Code writes one API
 * message as several records sharing its id, each repeating the message's
 * usage, so usage is kept once per id (the last record's).
 */
class AssistantMessages {
  private readonly usageById = new Map<string, TokenUsage>();
  /** The model of the first API message. */
  model: string | null = null;

  add(record: JsonRecord): void {
    const message = record.message as { id?: unknown; model?: unknown; usage?: unknown } | undefined;
    // `<synthetic>` messages are stubs Claude Code writes itself, not model replies.
    if (!message || typeof message.id !== "string" || message.model === "<synthetic>") return;
    if (!this.model && typeof message.model === "string") this.model = message.model;
    const usage = (message.usage ?? {}) as Record<string, unknown>;
    this.usageById.set(message.id, {
      input: tokenCount(usage.input_tokens),
      output: tokenCount(usage.output_tokens),
      cacheCreation: tokenCount(usage.cache_creation_input_tokens),
      cacheRead: tokenCount(usage.cache_read_input_tokens),
    });
  }

  get count(): number {
    return this.usageById.size;
  }

  get tokens(): TokenUsage {
    return sumUsage(this.usageById.values());
  }
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sumUsage(usages: Iterable<TokenUsage>): TokenUsage {
  const total: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const usage of usages) {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheCreation += usage.cacheCreation;
    total.cacheRead += usage.cacheRead;
  }
  return total;
}

/**
 * Text Claude Code itself writes into user records: slash-command wrappers,
 * local command output, interrupt markers, task events, skill bodies and
 * subagent hand-backs. A record starting with one of these was not typed.
 */
const HARNESS_TEXT_PREFIXES = [
  "<command-",
  "<local-command-",
  "<task-notification",
  "<bash-",
  "<user-memory-input",
  "[Request interrupted",
  "Caveat: The messages below were generated",
  "Base directory for this skill",
  "Another Claude session sent a message",
];

/** Blocks Claude Code or an IDE inserts around what the person typed. */
const INJECTED_BLOCKS = /<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics)>[\s\S]*?<\/\1>/g;

/** The text of a user record if the person typed it, otherwise null. */
function typedUserText(record: JsonRecord): string | null {
  if (record.isMeta === true || record.isSidechain === true) return null;
  if (record.toolUseResult !== undefined || record.sourceToolAssistantUUID !== undefined) return null;
  // Newer Claude Code versions say who wrote the record; older ones leave `origin` out.
  const origin = record.origin as { kind?: unknown } | undefined;
  if (origin && origin.kind !== "human") return null;

  const message = record.message as { content?: unknown } | undefined;
  const content = message?.content;
  let raw: string;
  if (typeof content === "string") {
    raw = content;
  } else if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content as { type?: unknown; text?: unknown }[]) {
      if (block?.type === "tool_result") return null; // fed back by Claude Code, not typed
      if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
    raw = texts.join("\n");
  } else {
    return null;
  }

  if (HARNESS_TEXT_PREFIXES.some((prefix) => raw.trimStart().startsWith(prefix))) return null;
  const text = raw.replace(INJECTED_BLOCKS, "").trim();
  return text.length > 0 ? text : null;
}
