import { createHash } from "node:crypto";
import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { redact } from "./redact.js";

/** The purpose of a User Message (see GLOSSARY.md). */
export const intents = ["New Task", "Correction", "Clarification", "Approval", "Follow-up"] as const;
export type Intent = (typeof intents)[number];

/** One Task found in a Session, with the User Messages that belong to it. */
export interface SplitTask {
  title: string;
  messages: { index: number; intent: Intent }[];
}

/** The Model Provider's reply could not be used for this Session. */
export class MalformedReplyError extends Error {
  override name = "MalformedReplyError";

  /** `tokens`: what the unusable reply still cost. */
  constructor(
    message: string,
    readonly tokens: TokenCount = { input: 0, output: 0 },
  ) {
    super(message);
  }
}

const replySchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string().min(1).describe("Short imperative description of the goal, e.g. 'Add a checkout button'"),
      messages: z.array(
        z.object({
          index: z.number().int().describe("Index of the User Message, as given in the request"),
          intent: z.enum(intents),
        }),
      ),
    }),
  ),
});

const system = `You analyze one AI coding session. You are given only the messages the person typed, numbered from 0.
Split the session into Tasks: one Task per distinct goal the person pursued. Assign every message to exactly one Task, in order.
Label every message with its Intent:
- "New Task": starts a new goal.
- "Correction": rejects or fixes something the agent did ("no, use pnpm", "that broke the build").
- "Clarification": explains or answers a question about what was already asked.
- "Approval": accepts the agent's work or lets it proceed ("looks good", "yes go ahead").
- "Follow-up": asks for more within the same goal, or changes the person's own mind. Asking for more, or changing one's own mind, is a Follow-up, never a Correction.
Text like [REDACTED:api-key] replaced a secret; treat it as an opaque value.`;

/** The request text sent to the Model Provider for a Session's User Messages, with secrets redacted. */
export function taskSplitPrompt(messages: readonly string[]): string {
  return messages.map((text, index) => `<message index="${index}">\n${redact(text)}\n</message>`).join("\n");
}

/**
 * Identifies what Analysis would send for these User Messages: their redacted
 * text, in order. Two reads of a Session with the same fingerprint need the
 * same Analysis, however the Harness's files changed around them.
 */
export function analysisFingerprint(messages: readonly string[]): string {
  return createHash("sha256").update(taskSplitPrompt(messages)).digest("hex");
}

/** Tokens a request and its reply used, or are expected to use. */
export interface TokenCount {
  input: number;
  output: number;
}

/** Rough characters per token for English text and code. */
const charsPerToken = 4;
/** The JSON schema and wrapping the AI SDK adds to every structured request. */
const requestOverheadTokens = 250;
/** Expected reply size: a Task title plus one labelled entry per User Message. */
const replyTokensPerTask = 30;
const replyTokensPerMessage = 15;

/** The tokens splitting these User Messages into Tasks is expected to use, without calling the Model Provider. */
export function estimateTaskSplit(messages: readonly string[]): TokenCount {
  if (messages.length === 0) return { input: 0, output: 0 };
  const chars = system.length + taskSplitPrompt(messages).length;
  return {
    input: Math.ceil(chars / charsPerToken) + requestOverheadTokens,
    output: replyTokensPerTask + replyTokensPerMessage * messages.length,
  };
}

/** Splits a Session into Tasks and labels the Intent of every User Message, using `model`. */
export async function splitIntoTasks(
  model: Exclude<LanguageModel, string>,
  messages: readonly string[],
  signal?: AbortSignal,
): Promise<{ tasks: SplitTask[]; tokens: TokenCount }> {
  if (messages.length === 0) return { tasks: [], tokens: { input: 0, output: 0 } };
  let output: z.infer<typeof replySchema>;
  let tokens: TokenCount;
  try {
    const result = await generateText({
      model,
      system,
      prompt: taskSplitPrompt(messages),
      output: Output.object({ schema: replySchema }),
      temperature: 0,
      abortSignal: signal,
    });
    output = result.output;
    tokens = tokenCount(result.usage);
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new MalformedReplyError(`The Model Provider's reply did not match the expected shape: ${error.message}`, tokenCount(error.usage));
    }
    throw error;
  }
  checkEveryMessageOnce(output.tasks, messages.length, tokens);
  return { tasks: output.tasks, tokens };
}

function tokenCount(usage: { inputTokens: number | undefined; outputTokens: number | undefined } | undefined): TokenCount {
  return { input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0 };
}

function checkEveryMessageOnce(tasks: SplitTask[], count: number, tokens: TokenCount): void {
  const seen = new Set<number>();
  for (const { index } of tasks.flatMap((t) => t.messages)) {
    if (index < 0 || index >= count) throw new MalformedReplyError(`The reply names message ${index}, but there are only ${count}.`, tokens);
    if (seen.has(index)) throw new MalformedReplyError(`The reply assigns message ${index} more than once.`, tokens);
    seen.add(index);
  }
  if (seen.size !== count) throw new MalformedReplyError(`The reply left ${count - seen.size} of ${count} messages without an Intent.`, tokens);
}
