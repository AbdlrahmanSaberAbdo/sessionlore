import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { redact } from "./redact.js";
import { MalformedReplyError } from "./tasks.js";

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

/** Names a Cluster from its Task titles, using `model` (the cheap model). */
export async function nameCluster(model: Exclude<LanguageModel, string>, taskTitles: readonly string[]): Promise<string> {
  try {
    const { output } = await generateText({
      model,
      system: nameSystem,
      prompt: clusterNamePrompt(taskTitles),
      output: Output.object({ schema: nameSchema }),
      temperature: 0,
    });
    return output.name.trim();
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new MalformedReplyError(`The Model Provider's reply did not match the expected shape: ${error.message}`);
    }
    throw error;
  }
}
