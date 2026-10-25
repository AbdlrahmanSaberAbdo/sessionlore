import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { redact } from "./redact.js";
import { estimateRequest, MalformedReplyError, type TokenCount } from "./tasks.js";

/**
 * Clusters of similar Tasks (ADR 0003), built from local embeddings (ADR 0004).
 * Clustering is incremental (ADR 0008): a new Task joins the most similar
 * existing Cluster when it is similar enough, and only Tasks that fit none start
 * new Clusters. Existing Clusters are never split or merged here.
 */

/** Cosine similarity a Task needs with a Cluster's centroid to join it. */
export const CLUSTER_SIMILARITY = 0.65;

export interface ClusterVectors<K> {
  id: K;
  /** Embeddings of the Cluster's current Tasks. */
  vectors: readonly (readonly number[])[];
}

export interface TaskVector<T> {
  task: T;
  vector: readonly number[];
}

/**
 * Where each new Task goes: `cluster` is an existing Cluster's id, or a
 * `newCluster` index shared by the new Tasks that start one Cluster together.
 * Tasks are placed in the order given, so the result is deterministic.
 */
export type Placement<K, T> = { task: T } & ({ cluster: K } | { newCluster: number });

export function placeTasks<K, T>(
  clusters: readonly ClusterVectors<K>[],
  tasks: readonly TaskVector<T>[],
  similarity = CLUSTER_SIMILARITY,
): Placement<K, T>[] {
  type Candidate = { ref: { cluster: K } | { newCluster: number }; sum: number[] };
  const candidates: Candidate[] = clusters
    .filter((c) => c.vectors.length > 0)
    .map((c) => ({ ref: { cluster: c.id }, sum: sumOf(c.vectors) }));
  let newClusters = 0;
  return tasks.map(({ task, vector }) => {
    let best: Candidate | undefined;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const score = cosine(candidate.sum, vector);
      if (score > bestScore) [best, bestScore] = [candidate, score];
    }
    if (best && bestScore >= similarity) {
      addInto(best.sum, vector);
      return { task, ...best.ref };
    }
    const ref = { newCluster: newClusters++ };
    candidates.push({ ref, sum: [...vector] });
    return { task, ...ref };
  });
}

/**
 * How a grouping rebuilt from scratch takes over from the old Clusters (ADR 0008).
 * Each old Cluster maps to the new group holding most of its Tasks. Each new
 * group keeps the identity of the old Cluster, among those mapped to it, that
 * shares the most Tasks with it; a new group no old Cluster passes its identity
 * to is a new Cluster. Ties go to whichever comes first in the groups' order.
 */
export interface Succession<K> {
  /** Per new group, by index: the old Cluster whose identity it keeps, if any. */
  heirs: (K | undefined)[];
  /** Per old Cluster: the index of the new group it maps to. */
  targets: Map<K, number>;
}

export function succession<K, T>(groups: readonly (readonly T[])[], oldClusterOf: (task: T) => K | undefined): Succession<K> {
  const overlap = groups.map((tasks) => {
    const counts = new Map<K, number>();
    for (const task of tasks) {
      const old = oldClusterOf(task);
      if (old !== undefined) counts.set(old, (counts.get(old) ?? 0) + 1);
    }
    return counts;
  });
  const targets = new Map<K, number>();
  const best = new Map<K, number>();
  overlap.forEach((counts, group) => {
    for (const [old, n] of counts) {
      if (n <= (best.get(old) ?? 0)) continue;
      best.set(old, n);
      targets.set(old, group);
    }
  });
  const heirs = overlap.map((counts, group) => {
    let heir: K | undefined;
    for (const [old, n] of counts) {
      if (targets.get(old) === group && (heir === undefined || n > counts.get(heir)!)) heir = old;
    }
    return heir;
  });
  return { heirs, targets };
}

function sumOf(vectors: readonly (readonly number[])[]): number[] {
  const sum = new Array<number>(vectors[0]!.length).fill(0);
  for (const v of vectors) addInto(sum, v);
  return sum;
}

function addInto(sum: number[], vector: readonly number[]): void {
  for (let i = 0; i < sum.length; i++) sum[i]! += vector[i] ?? 0;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** The text a Task is embedded as. */
export function taskEmbeddingText(title: string, firstMessage: string | undefined): string {
  return firstMessage ? `${title}\n\n${firstMessage}` : title;
}

const nameSchema = z.object({
  name: z.string().min(1).max(80).describe("Short name for the kind of work, e.g. 'Write database migrations'"),
});

const nameSystem = `You name a group of similar Tasks from someone's AI coding sessions.
Reply with a short name (2 to 6 words, imperative, no trailing period) for the kind of work these Tasks share.
Text like [REDACTED:api-key] replaced a secret; treat it as an opaque value.`;

/** The request text sent to name a Cluster from its Task titles, with secrets redacted. */
export function clusterNamePrompt(taskTitles: readonly string[]): string {
  return taskTitles.map((title) => `<task>${redact(title)}</task>`).join("\n");
}

/** Expected reply size of a naming request: a short name in JSON. */
const nameReplyTokens = 20;

/** The tokens naming a Cluster with these Task titles is expected to use. */
export function estimateClusterName(taskTitles: readonly string[]): TokenCount {
  return estimateRequest(nameSystem, clusterNamePrompt(taskTitles), nameReplyTokens);
}

/** The tokens naming a Correction Cluster with these Corrections is expected to use. */
export function estimateCorrectionClusterName(corrections: readonly string[]): TokenCount {
  return estimateRequest(correctionNameSystem, correctionClusterNamePrompt(corrections), nameReplyTokens);
}

/** Names a Cluster from its Task titles, using `model` (the cheap model). */
export function nameCluster(
  model: Exclude<LanguageModel, string>,
  taskTitles: readonly string[],
  signal?: AbortSignal,
): Promise<{ name: string; tokens: TokenCount }> {
  return nameGroup(model, nameSystem, clusterNamePrompt(taskTitles), signal);
}

const correctionNameSchema = z.object({
  name: z.string().min(1).max(80).describe("The standing instruction these Corrections share, e.g. 'Use pnpm, not npm'"),
});

const correctionNameSystem = `You name a group of similar Corrections: messages in which someone rejected or fixed what their AI coding agent did.
Reply with a short name (2 to 8 words, imperative, no trailing period) for what the person keeps asking the agent to do instead.
Text like [REDACTED:api-key] replaced a secret; treat it as an opaque value.`;

/** The request text sent to name a Correction Cluster from its Corrections, with secrets redacted. */
export function correctionClusterNamePrompt(corrections: readonly string[]): string {
  return corrections.map((text) => `<correction>${redact(text)}</correction>`).join("\n");
}

/** Names a Correction Cluster from its Corrections' text, using `model` (the cheap model). */
export function nameCorrectionCluster(
  model: Exclude<LanguageModel, string>,
  corrections: readonly string[],
  signal?: AbortSignal,
): Promise<{ name: string; tokens: TokenCount }> {
  return nameGroup(model, correctionNameSystem, correctionClusterNamePrompt(corrections), signal, correctionNameSchema);
}

async function nameGroup(
  model: Exclude<LanguageModel, string>,
  system: string,
  prompt: string,
  signal: AbortSignal | undefined,
  schema: typeof nameSchema = nameSchema,
): Promise<{ name: string; tokens: TokenCount }> {
  try {
    const result = await generateText({
      model,
      system,
      prompt,
      output: Output.object({ schema }),
      temperature: 0,
      abortSignal: signal,
    });
    return { name: result.output.name.trim(), tokens: tokenCount(result.usage) };
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

function tokenCount(usage: { inputTokens: number | undefined; outputTokens: number | undefined } | undefined): TokenCount {
  return { input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0 };
}
