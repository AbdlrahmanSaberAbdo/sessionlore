import type { LanguageModel } from "ai";

/**
 * Dependencies injected from outside so tests (Seam 1) can control them.
 * Production wiring supplies real implementations; tests supply fakes.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Turns texts into vectors for clustering (ADR 0004). */
export interface Embedder {
  embed(texts: readonly string[]): Promise<number[][]>;
}

/**
 * The Model Provider's two model slots (ADR 0007): a cheap model for
 * per-Session work and a strong model for writing Suggestions. Both are Vercel
 * AI SDK language model objects; bare model id strings are excluded because
 * the SDK would route them through its hosted gateway instead of the
 * configured Model Provider.
 */
export type ModelProviderModel = Exclude<LanguageModel, string>;

export interface ModelProvider {
  readonly cheap: ModelProviderModel;
  readonly strong: ModelProviderModel;
}

export type Env = Readonly<Record<string, string | undefined>>;
