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

/** Splits a Session into Tasks and labels the Intent of every User Message, using `model`. */
export async function splitIntoTasks(model: Exclude<LanguageModel, string>, messages: readonly string[]): Promise<SplitTask[]> {
  if (messages.length === 0) return [];
  let output: z.infer<typeof replySchema>;
  try {
    ({ output } = await generateText({
      model,
      system,
      prompt: taskSplitPrompt(messages),
      output: Output.object({ schema: replySchema }),
      temperature: 0,
    }));
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new MalformedReplyError(`The Model Provider's reply did not match the expected shape: ${error.message}`);
    }
    throw error;
  }
  checkEveryMessageOnce(output.tasks, messages.length);
  return output.tasks;
}

function checkEveryMessageOnce(tasks: SplitTask[], count: number): void {
  const seen = new Set<number>();
  for (const { index } of tasks.flatMap((t) => t.messages)) {
    if (index < 0 || index >= count) throw new MalformedReplyError(`The reply names message ${index}, but there are only ${count}.`);
    if (seen.has(index)) throw new MalformedReplyError(`The reply assigns message ${index} more than once.`);
    seen.add(index);
  }
  if (seen.size !== count) throw new MalformedReplyError(`The reply left ${count - seen.size} of ${count} messages without an Intent.`);
}
