import type { Embedder } from "@sessionlore/core";

/**
 * A deterministic fake Embedder for Seam 1 tests, so clustering is repeatable
 * and no model is downloaded. Texts that mention the same topic get the same
 * vector; every other text gets its own pseudo-random vector, nearly
 * orthogonal to everything else.
 */
export function topicEmbedder(topics: readonly string[], modelId = "fake-topic-embedder"): Embedder & { calls: string[][] } {
  const randomDims = 64;
  const calls: string[][] = [];
  return {
    modelId,
    calls,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((text) => {
        const vector = new Array<number>(topics.length + randomDims).fill(0);
        const topic = topics.findIndex((t) => text.toLowerCase().includes(t.toLowerCase()));
        if (topic >= 0) {
          vector[topic] = 1;
          return vector;
        }
        let seed = hash(text);
        for (let i = 0; i < randomDims; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          vector[topics.length + i] = seed / 2 ** 32 - 0.5;
        }
        const norm = Math.hypot(...vector);
        return vector.map((v) => v / norm);
      });
    },
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}
