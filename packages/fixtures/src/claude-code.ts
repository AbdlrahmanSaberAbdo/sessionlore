import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FixtureHome } from "./home.js";

/**
 * Builds synthetic Claude Code storage: one JSONL file per Session under
 * `~/.claude/projects/<encoded cwd>/<session id>.jsonl`, with records shaped
 * like the ones Claude Code writes. Subagent transcripts go next to it in
 * `<session id>/subagents/agent-<agent id>.jsonl`. Every file's modification
 * time is set to its last record's timestamp, as if Claude Code had just written it.
 */

/** Token usage as Claude Code records it on an assistant message. */
export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

const DEFAULT_USAGE: ClaudeUsage = {
  input_tokens: 10,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

export type ClaudeTurn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; blocks: string[]; usage: ClaudeUsage }
  | { kind: "tool"; name: string; input: Record<string, unknown>; result: string }
  | { kind: "meta"; text: string }
  | { kind: "injected"; text: string; origin?: Record<string, unknown> }
  | { kind: "subagent"; description: string; prompt: string; turns: ClaudeTurn[]; result: string }
  | { kind: "record"; fields: Record<string, unknown> }
  | { kind: "abandoned"; turns: ClaudeTurn[] };

/** Turns of a Claude Code Session, in the order they happen. */
export const turn = {
  /** Text the person typed. */
  user: (text: string): ClaudeTurn => ({ kind: "user", text }),
  /** A plain assistant reply. */
  assistant: (text: string, usage: ClaudeUsage = DEFAULT_USAGE): ClaudeTurn => ({
    kind: "assistant",
    blocks: [text],
    usage,
  }),
  /**
   * One assistant API message that Claude Code writes as several records, one
   * per content block, all sharing the message id and repeating its usage.
   */
  splitAssistant: (blocks: string[], usage: ClaudeUsage = DEFAULT_USAGE): ClaudeTurn => ({
    kind: "assistant",
    blocks,
    usage,
  }),
  /** An assistant tool call and the tool result Claude Code feeds back as a user record. */
  tool: (name: string, input: Record<string, unknown>, result: string): ClaudeTurn => ({
    kind: "tool",
    name,
    input,
    result,
  }),
  /** Text the Harness injects into the conversation as a user record (isMeta). */
  meta: (text: string): ClaudeTurn => ({ kind: "meta", text }),
  /** The wrapper Claude Code writes as a user record when the person runs a slash command. */
  command: (name: string, args = ""): ClaudeTurn => ({
    kind: "injected",
    text: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`,
  }),
  /** Output of a local command (e.g. `/cost`) that Claude Code writes as a user record. */
  localCommandOutput: (stdout: string): ClaudeTurn => ({
    kind: "injected",
    text: `<local-command-stdout>${stdout}</local-command-stdout>`,
  }),
  /** The marker Claude Code writes when the person interrupts the agent. */
  interrupted: (): ClaudeTurn => ({ kind: "injected", text: "[Request interrupted by user]" }),
  /** A background-task event Claude Code feeds back as a user record. */
  taskNotification: (summary: string): ClaudeTurn => ({
    kind: "injected",
    text: `<task-notification>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`,
    origin: { kind: "task-notification" },
  }),
  /**
   * An Agent tool call: the parent's tool call and result, plus the subagent's
   * own transcript (starting with the prompt the parent agent wrote) in its own file.
   */
  subagent: (spec: { description: string; prompt: string; turns: ClaudeTurn[]; result: string }): ClaudeTurn => ({
    kind: "subagent",
    ...spec,
  }),
  /** Any record, written verbatim on top of the common envelope (uuid, parentUuid, timestamp, ...). */
  record: (fields: Record<string, unknown>): ClaudeTurn => ({ kind: "record", fields }),
  /**
   * Turns on a branch the conversation later left, as when the person edits an
   * earlier message or rewinds: they stay in the file, but the turns after this
   * one continue from the record before them.
   */
  abandoned: (turns: ClaudeTurn[]): ClaudeTurn => ({ kind: "abandoned", turns }),
};

export interface ClaudeSessionSpec {
  /** Working directory Claude Code recorded for the Session. */
  cwd: string;
  /** ISO timestamp of the first record. */
  startedAt: string;
  turns: ClaudeTurn[];
  /** Session id; generated when omitted. */
  id?: string;
  /** Seconds between consecutive records. Defaults to 30. */
  stepSeconds?: number;
  gitBranch?: string;
}

export interface WrittenClaudeSession {
  id: string;
  file: string;
}

const CLAUDE_CODE_VERSION = "2.0.14";
const MODEL = "claude-sonnet-4-5-20250929";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

function nextAgentId(): string {
  counter += 1;
  return `a${counter.toString(16).padStart(16, "0")}`;
}

/** Claude Code names a project folder after its cwd with `/` and `.` replaced by `-`. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export function claudeProjectsDir(home: FixtureHome): string {
  return home.resolve(join(".claude", "projects"));
}

interface Transcript {
  /** Fields every record of this transcript carries. */
  envelope: Record<string, unknown>;
  records: Record<string, unknown>[];
  parentUuid: string | null;
}

interface SubagentFile {
  agentId: string;
  records: Record<string, unknown>[];
  meta: Record<string, unknown>;
}

export function writeClaudeSession(home: FixtureHome, spec: ClaudeSessionSpec): WrittenClaudeSession {
  const sessionId = spec.id ?? nextId();
  const step = (spec.stepSeconds ?? 30) * 1000;
  let clock = Date.parse(spec.startedAt);
  if (Number.isNaN(clock)) throw new Error(`Invalid startedAt: ${spec.startedAt}`);

  const baseEnvelope = {
    isSidechain: false,
    userType: "external",
    cwd: spec.cwd,
    sessionId,
    version: CLAUDE_CODE_VERSION,
    gitBranch: spec.gitBranch ?? "main",
  };
  const subagents: SubagentFile[] = [];

  const push = (transcript: Transcript, record: Record<string, unknown>): void => {
    const uuid = nextId();
    transcript.records.push({
      parentUuid: transcript.parentUuid,
      ...transcript.envelope,
      ...record,
      uuid,
      timestamp: new Date(clock).toISOString(),
    });
    transcript.parentUuid = uuid;
    clock += step;
  };

  /** Writes one API message as one record per content block, as Claude Code does. */
  const assistant = (transcript: Transcript, blocks: object[], usage: ClaudeUsage = DEFAULT_USAGE): void => {
    const requestId = `req_${nextId()}`;
    const messageId = `msg_${nextId()}`;
    blocks.forEach((block, index) => {
      push(transcript, {
        type: "assistant",
        requestId,
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [block],
          stop_reason: index === blocks.length - 1 ? "end_turn" : null,
          usage: { ...usage },
        },
      });
    });
  };

  const toolResult = (transcript: Transcript, toolUseId: string, text: string, toolUseResult: unknown): void => {
    push(transcript, {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] },
      toolUseResult,
    });
  };

  const writeTurns = (transcript: Transcript, turns: ClaudeTurn[]): void => {
    for (const t of turns) {
      switch (t.kind) {
        case "user":
          push(transcript, { type: "user", message: { role: "user", content: t.text } });
          break;
        case "meta":
          push(transcript, { type: "user", isMeta: true, message: { role: "user", content: t.text } });
          break;
        case "injected":
          push(transcript, {
            type: "user",
            ...(t.origin ? { origin: t.origin } : {}),
            message: { role: "user", content: t.text },
          });
          break;
        case "assistant":
          assistant(
            transcript,
            t.blocks.map((text) => ({ type: "text", text })),
            t.usage,
          );
          break;
        case "tool": {
          const toolUseId = `toolu_${nextId()}`;
          assistant(transcript, [{ type: "tool_use", id: toolUseId, name: t.name, input: t.input }]);
          toolResult(transcript, toolUseId, t.result, { stdout: t.result, stderr: "", interrupted: false });
          break;
        }
        case "subagent": {
          const toolUseId = `toolu_${nextId()}`;
          const agentId = nextAgentId();
          const input = { description: t.description, prompt: t.prompt, subagent_type: "general-purpose" };
          assistant(transcript, [{ type: "tool_use", id: toolUseId, name: "Agent", input }]);

          const sidechain: Transcript = {
            envelope: { ...baseEnvelope, isSidechain: true, agentId },
            records: [],
            parentUuid: null,
          };
          push(sidechain, { type: "user", message: { role: "user", content: t.prompt } });
          writeTurns(sidechain, t.turns);
          subagents.push({
            agentId,
            records: sidechain.records,
            meta: { agentType: "general-purpose", description: t.description, toolUseId },
          });

          toolResult(transcript, toolUseId, t.result, {
            status: "completed",
            agentId,
            prompt: t.prompt,
            content: [{ type: "text", text: t.result }],
          });
          break;
        }
        case "record":
          push(transcript, t.fields);
          break;
        case "abandoned": {
          const branchPoint = transcript.parentUuid;
          writeTurns(transcript, t.turns);
          transcript.parentUuid = branchPoint;
          break;
        }
      }
    }
  };

  const main: Transcript = { envelope: baseEnvelope, records: [], parentUuid: null };
  writeTurns(main, spec.turns);

  const dir = join(claudeProjectsDir(home), encodeClaudeProjectDir(spec.cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeJsonl(file, main.records);

  if (subagents.length > 0) {
    const subagentDir = join(dir, sessionId, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    for (const subagent of subagents) {
      writeJsonl(join(subagentDir, `agent-${subagent.agentId}.jsonl`), subagent.records);
      writeFileSync(join(subagentDir, `agent-${subagent.agentId}.meta.json`), JSON.stringify(subagent.meta));
    }
  }
  return { id: sessionId, file };
}

function writeJsonl(file: string, records: Record<string, unknown>[]): void {
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const last = records.at(-1)?.timestamp;
  if (typeof last === "string") {
    const time = new Date(last);
    utimesSync(file, time, time);
  }
}
