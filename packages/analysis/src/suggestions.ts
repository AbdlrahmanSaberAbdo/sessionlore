import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { redact } from "./redact.js";
import { MalformedReplyError, type Intent, type TokenCount } from "./tasks.js";

/**
 * Writing Suggestions with the strong model. The result is the format-neutral
 * form (ADR 0005); turning it into a Harness's files is a Renderer's job.
 */

/** One Task of a Workflow, as the strong model is shown it. */
export interface WorkflowTask {
  title: string;
  userMessages: { text: string; intent: Intent }[];
}

export interface WorkflowForSkill {
  name: string;
  tasks: readonly WorkflowTask[];
}

/** The neutral content of a Skill: what the strong model writes. */
export interface SkillDraft {
  title: string;
  trigger: string;
  steps: string[];
}

/** Tasks shown to the strong model per Workflow; the most recent ones are used. */
export const SKILL_EVIDENCE_SAMPLE = 8;
/** Characters kept of each User Message shown to the strong model. */
const MESSAGE_CHARS = 1500;

const skillSchema = z.object({
  title: z.string().min(1).max(80).describe("Short imperative name of the procedure, e.g. 'Write a database migration'"),
  trigger: z
    .string()
    .min(1)
    .max(400)
    .describe("One or two sentences saying when an agent should use this Skill, e.g. 'Use when adding or changing a database table.'"),
  steps: z.array(z.string().min(1)).min(1).max(15).describe("The procedure, one instruction per step, in order"),
});

const skillSystem = `You write a Skill for AI coding agents: a reusable procedure an agent follows when a kind of work comes up again.
You are given a Workflow: a kind of work the person keeps asking their agents to do, with the messages they typed in several Tasks of it.
Each message is labelled with its Intent. Corrections show what the agent got wrong; make the steps prevent those mistakes.
Write steps that are concrete and general: they must fit every Task shown, not just one. Do not mention the person or these specific Tasks.
Text like [REDACTED:api-key] replaced a secret; treat it as an opaque value and never copy it into the Skill.`;

/** The request text sent to write a Skill for a Workflow, with secrets redacted. */
export function skillPrompt(workflow: WorkflowForSkill): string {
  const tasks = workflow.tasks.slice(-SKILL_EVIDENCE_SAMPLE).map((task) => {
    const messages = task.userMessages
      .map((m) => `<message intent="${m.intent}">\n${redact(m.text.slice(0, MESSAGE_CHARS))}\n</message>`)
      .join("\n");
    return `<task title="${escapeAttribute(redact(task.title))}">\n${messages}\n</task>`;
  });
  return `<workflow name="${escapeAttribute(redact(workflow.name))}">\n${tasks.join("\n")}\n</workflow>`;
}

/** Writes a Skill for a Workflow using `model` (the strong model). */
export async function writeSkill(
  model: Exclude<LanguageModel, string>,
  workflow: WorkflowForSkill,
  signal?: AbortSignal,
): Promise<{ skill: SkillDraft; tokens: TokenCount }> {
  try {
    const result = await generateText({
      model,
      system: skillSystem,
      prompt: skillPrompt(workflow),
      output: Output.object({ schema: skillSchema }),
      temperature: 0,
      abortSignal: signal,
    });
    const { title, trigger, steps } = result.output;
    return {
      skill: { title: title.trim(), trigger: trigger.trim(), steps: steps.map((s) => s.trim()) },
      tokens: tokenCount(result.usage),
    };
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new MalformedReplyError(
        `The Model Provider's reply did not match the expected shape: ${error.message}`,
        tokenCount(error.usage),
      );
    }
    throw error;
  }
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function tokenCount(usage: { inputTokens: number | undefined; outputTokens: number | undefined } | undefined): TokenCount {
  return { input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0 };
}
