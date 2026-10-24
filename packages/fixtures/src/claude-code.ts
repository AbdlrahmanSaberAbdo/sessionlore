import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FixtureHome } from "./home.js";

/**
 * Builds synthetic Claude Code storage: one JSONL file per Session under
 * `~/.claude/projects/<encoded cwd>/<session id>.jsonl`, with records shaped
 * like the ones Claude Code writes.
 */

export type ClaudeTurn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown>; result: string }
  | { kind: "meta"; text: string };

/** Turns of a Claude Code Session, in the order they happen. */
export const turn = {
  /** Text the person typed. */
  user: (text: string): ClaudeTurn => ({ kind: "user", text }),
  /** A plain assistant reply. */
  assistant: (text: string): ClaudeTurn => ({ kind: "assistant", text }),
  /** An assistant tool call and the tool result Claude Code feeds back as a user record. */
  tool: (name: string, input: Record<string, unknown>, result: string): ClaudeTurn => ({
    kind: "tool",
    name,
    input,
    result,
  }),
  /** Text the Harness injects into the conversation as a user record (isMeta). */
  meta: (text: string): ClaudeTurn => ({ kind: "meta", text }),
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

/** Claude Code names a project folder after its cwd with `/` and `.` replaced by `-`. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export function claudeProjectsDir(home: FixtureHome): string {
  return home.resolve(join(".claude", "projects"));
}

export function writeClaudeSession(home: FixtureHome, spec: ClaudeSessionSpec): WrittenClaudeSession {
  const sessionId = spec.id ?? nextId();
  const step = (spec.stepSeconds ?? 30) * 1000;
  let clock = Date.parse(spec.startedAt);
  if (Number.isNaN(clock)) throw new Error(`Invalid startedAt: ${spec.startedAt}`);

  const records: object[] = [];
  let parentUuid: string | null = null;

  const push = (record: Record<string, unknown>): void => {
    const uuid = nextId();
    records.push({
      parentUuid,
      isSidechain: false,
      userType: "external",
      cwd: spec.cwd,
      sessionId,
      version: CLAUDE_CODE_VERSION,
      gitBranch: spec.gitBranch ?? "main",
      ...record,
      uuid,
      timestamp: new Date(clock).toISOString(),
    });
    parentUuid = uuid;
    clock += step;
  };

  const assistant = (content: object[]): void => {
    push({
      type: "assistant",
      requestId: `req_${nextId()}`,
      message: {
        id: `msg_${nextId()}`,
        type: "message",
        role: "assistant",
        model: MODEL,
        content,
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 },
      },
    });
  };

  for (const t of spec.turns) {
    switch (t.kind) {
      case "user":
        push({ type: "user", message: { role: "user", content: t.text } });
        break;
      case "meta":
        push({ type: "user", isMeta: true, message: { role: "user", content: t.text } });
        break;
      case "assistant":
        assistant([{ type: "text", text: t.text }]);
        break;
      case "tool": {
        const toolUseId = `toolu_${nextId()}`;
        assistant([{ type: "tool_use", id: toolUseId, name: t.name, input: t.input }]);
        push({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolUseId, content: t.result }],
          },
          toolUseResult: { stdout: t.result, stderr: "", interrupted: false },
        });
        break;
      }
    }
  }

  const dir = join(claudeProjectsDir(home), encodeClaudeProjectDir(spec.cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { id: sessionId, file };
}
