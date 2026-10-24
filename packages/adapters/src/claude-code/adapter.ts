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
 * dir is `$CLAUDE_CONFIG_DIR` or `~/.claude`. Files are only ever opened for reading.
 */
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
        const info = await stat(location);
        yield {
          externalId: basename(entry.name, ".jsonl"),
          location,
          changeMarker: `${info.size}:${info.mtimeMs}`,
        };
      }
    }
  },

  async readSession(source: SessionSource): Promise<HarnessSession | null> {
    let cwd: string | null = null;
    let startedAt: Date | null = null;
    let endedAt: Date | null = null;
    const userMessages: HarnessUserMessage[] = [];
    // Claude Code writes one API message as several records sharing its id, each
    // repeating the message's usage; keep one usage per id (the last record's).
    const usageByMessageId = new Map<string, TokenUsage>();

    for await (const record of readRecords(source.location)) {
      if (record.type === "assistant") {
        const message = assistantMessage(record);
        if (message) usageByMessageId.set(message.id, message.usage);
      }
      if (record.type !== "user" && record.type !== "assistant") continue;
      const timestamp = parseTimestamp(record.timestamp);
      if (timestamp) {
        if (!startedAt || timestamp < startedAt) startedAt = timestamp;
        if (!endedAt || timestamp > endedAt) endedAt = timestamp;
      }
      if (!cwd && typeof record.cwd === "string") cwd = record.cwd;

      if (record.type === "user" && timestamp) {
        const text = typedUserText(record);
        if (text !== null) userMessages.push({ text, timestamp });
      }
    }

    if (!startedAt || !endedAt) return null;
    return {
      externalId: source.externalId,
      cwd,
      startedAt,
      endedAt,
      userMessages,
      assistantTurnCount: usageByMessageId.size,
      tokens: sumUsage(usageByMessageId.values()),
    };
  },
};

/** The API message an assistant record belongs to, unless it is a Harness-made stub. */
function assistantMessage(record: JsonRecord): { id: string; usage: TokenUsage } | null {
  const message = record.message as { id?: unknown; model?: unknown; usage?: unknown } | undefined;
  if (!message || typeof message.id !== "string" || message.model === "<synthetic>") return null;
  const usage = (message.usage ?? {}) as Record<string, unknown>;
  return {
    id: message.id,
    usage: {
      input: tokenCount(usage.input_tokens),
      output: tokenCount(usage.output_tokens),
      cacheCreation: tokenCount(usage.cache_creation_input_tokens),
      cacheRead: tokenCount(usage.cache_read_input_tokens),
    },
  };
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

type JsonRecord = Record<string, unknown>;

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

/** The text of a user record if the person typed it, otherwise null. */
function typedUserText(record: JsonRecord): string | null {
  if (record.isMeta === true || record.isSidechain === true) return null;
  const message = record.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  for (const block of content as { type?: unknown; text?: unknown }[]) {
    if (block?.type === "tool_result") return null; // fed back by Claude Code, not typed
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts.length > 0 ? texts.join("\n") : null;
}
