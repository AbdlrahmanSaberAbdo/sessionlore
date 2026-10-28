import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir, type Embedder } from "@habitlore/core";

/**
 * The production Embedder (ADR 0004): a small sentence-embedding model run
 * locally with transformers.js. The model is not bundled; it is downloaded on
 * first use into `~/.habitlore/models` and read from there afterwards.
 */

const MODEL = "Xenova/all-MiniLM-L6-v2";
const PACKAGE = "@huggingface/transformers";

/** The part of `@huggingface/transformers` habitlore uses. */
export interface TransformersModule {
  env: { cacheDir?: string | null };
  pipeline(
    task: "feature-extraction",
    model: string,
    options?: { dtype?: string },
  ): Promise<(texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>>;
}

export interface LocalEmbedderOptions {
  homeDir: string;
  /** Tells the person about the one-time model download. */
  notify(text: string): void;
  /** Loads transformers.js; replaced in tests. */
  load?: () => Promise<TransformersModule>;
}

export function localEmbedder({ homeDir, notify, load = loadTransformers }: LocalEmbedderOptions): Embedder {
  const cacheDir = join(dataDir(homeDir), "models");
  let extractor: ReturnType<TransformersModule["pipeline"]> | undefined;

  const open = async () => {
    const transformers = await load().catch((error: unknown) => {
      throw new Error(
        `Clustering Tasks needs ${PACKAGE}, which could not be loaded (${error instanceof Error ? error.message : String(error)}). ` +
          `Reinstall habitlore, or install ${PACKAGE} next to it.`,
      );
    });
    transformers.env.cacheDir = cacheDir;
    if (!existsSync(join(cacheDir, MODEL))) {
      notify(`Downloading the local embedding model ${MODEL} (about 25 MB) into ${cacheDir}. This happens once.\n`);
    }
    return transformers.pipeline("feature-extraction", MODEL, { dtype: "q8" });
  };

  return {
    modelId: MODEL,
    async embed(texts) {
      if (texts.length === 0) return [];
      extractor ??= open();
      const run = await extractor.catch((error: unknown) => {
        extractor = undefined; // Let the next call retry, e.g. after a failed download.
        throw error;
      });
      const output = await run([...texts], { pooling: "mean", normalize: true });
      return output.tolist();
    },
  };
}

async function loadTransformers(): Promise<TransformersModule> {
  // A variable specifier keeps the bundler from inlining transformers.js and its native binaries.
  const specifier: string = PACKAGE;
  return (await import(specifier)) as TransformersModule;
}
