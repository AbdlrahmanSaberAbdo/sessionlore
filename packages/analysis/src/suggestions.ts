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
  const { output, tokens } = await generate(model, skillSystem, skillPrompt(workflow), skillSchema, signal);
  const { title, trigger, steps } = output;
  return { skill: { title: title.trim(), trigger: trigger.trim(), steps: steps.map((s) => s.trim()) }, tokens };
}

/** One Correction of a Correction Cluster, as the strong model is shown it. */
export interface ClusterCorrectionForRule {
  text: string;
  /** Title of the Task it corrected. */
  task: string;
}

export interface CorrectionClusterForRule {
  name: string;
  corrections: readonly ClusterCorrectionForRule[];
}

/** The neutral content of a Rule: what the strong model writes. */
export interface RuleDraft {
  title: string;
  rule: string;
}

/** Corrections shown to the strong model per Correction Cluster; the most recent ones are used. */
export const RULE_EVIDENCE_SAMPLE = 12;

const ruleSchema = z.object({
  title: z.string().min(1).max(80).describe("Short name of the Rule, e.g. 'Use pnpm'"),
  rule: z
    .string()
    .min(1)
    .max(300)
    .describe("The standing instruction, one imperative sentence, e.g. 'Use pnpm, never npm, to install packages and run scripts.'"),
});

const ruleSystem = `You write a Rule for AI coding agents: a one-line standing instruction an agent always follows.
You are given a Correction Cluster: similar Corrections a person typed to fix what their agents did, each with the Task it corrected.
Write the one instruction that would have prevented all of them. It must fit every Correction shown, not just one. Do not mention the person or these specific Tasks.
Text like [REDACTED:api-key] replaced a secret; treat it as an opaque value and never copy it into the Rule.`;

/** The request text sent to write a Rule for a Correction Cluster, with secrets redacted. */
export function rulePrompt(cluster: CorrectionClusterForRule): string {
  const corrections = cluster.corrections
    .slice(-RULE_EVIDENCE_SAMPLE)
    .map((c) => `<correction task="${escapeAttribute(redact(c.task))}">\n${redact(c.text.slice(0, MESSAGE_CHARS))}\n</correction>`);
  return `<correction-cluster name="${escapeAttribute(redact(cluster.name))}">\n${corrections.join("\n")}\n</correction-cluster>`;
}

/** Writes a Rule for a Correction Cluster using `model` (the strong model). */
export async function writeRule(
  model: Exclude<LanguageModel, string>,
  cluster: CorrectionClusterForRule,
  signal?: AbortSignal,
): Promise<{ rule: RuleDraft; tokens: TokenCount }> {
  const { output, tokens } = await generate(model, ruleSystem, rulePrompt(cluster), ruleSchema, signal);
  return { rule: { title: output.title.trim(), rule: output.rule.replace(/\s+/g, " ").trim() }, tokens };
}

async function generate<T>(
  model: Exclude<LanguageModel, string>,
  system: string,
  prompt: string,
  schema: z.ZodType<T>,
  signal: AbortSignal | undefined,
): Promise<{ output: T; tokens: TokenCount }> {
  try {
    const result = await generateText({
      model,
      system,
      prompt,
      output: Output.object({ schema }),
      temperature: 0,
      abortSignal: signal,
    });
    return { output: result.output as T, tokens: tokenCount(result.usage) };
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
