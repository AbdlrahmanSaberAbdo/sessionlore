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
          changeMarker: infos.map((info) => `${info.size}:${info.mtimeMs}`).join(","),
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

    for await (const record of readRecords(source.location)) {
      if (record.type !== "user" && record.type !== "assistant") continue;
      const timestamp = parseTimestamp(record.timestamp);
      if (timestamp) {
        if (!startedAt || timestamp < startedAt) startedAt = timestamp;
        if (!endedAt || timestamp > endedAt) endedAt = timestamp;
      }
      if (!cwd && typeof record.cwd === "string") cwd = record.cwd;

      if (record.type === "assistant") main.add(record);
      if (record.type === "user" && timestamp) {
        const text = typedUserText(record);
        if (text !== null) userMessages.push({ text, timestamp });
      }
    }
    if (!startedAt || !endedAt) return null;

    // A subagent's records are all written by agents, never by the person: only its token usage counts.
    const subagents = await subagentFiles(source.location);
    const subagentUsage = new AssistantMessages();
    for (const file of subagents) {
      for await (const record of readRecords(file)) {
        if (record.type === "assistant") subagentUsage.add(record);
      }
    }

    return {
      externalId: source.externalId,
      cwd,
      startedAt,
      endedAt,
      userMessages,
      assistantTurnCount: main.count,
      subagentRunCount: subagents.length,
      tokens: sumUsage([main.tokens, subagentUsage.tokens]),
    };
  },
};

type JsonRecord = Record<string, unknown>;

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

  add(record: JsonRecord): void {
    const message = record.message as { id?: unknown; model?: unknown; usage?: unknown } | undefined;
    // `<synthetic>` messages are stubs Claude Code writes itself, not model replies.
    if (!message || typeof message.id !== "string" || message.model === "<synthetic>") return;
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
