import type { TokenCount } from "@sessionlore/analysis";
import { isPlainObject, type SectionContext } from "./config.js";

/**
 * What a model costs, in US dollars per million tokens. The config file's
 * `prices` section sets prices for models sessionlore does not know, and
 * overrides the built-in ones:
 *
 *   "prices": { "my-model": { "inputPerMillion": 0.5, "outputPerMillion": 1.5 } }
 */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

export type Prices = Readonly<Record<string, ModelPrice>>;

/** Anthropic first-party API list prices (cached 2026-10). Prices from other providers come from the config. */
const builtInPrices: Prices = {
  "claude-fable-5-1": { inputPerMillion: 10, outputPerMillion: 50 },
  "claude-fable-5": { inputPerMillion: 10, outputPerMillion: 50 },
  "claude-opus-5-5": { inputPerMillion: 4, outputPerMillion: 20 },
  "claude-opus-5": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-8": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-7": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-sonnet-5-5": { inputPerMillion: 2, outputPerMillion: 10 },
  "claude-sonnet-5": { inputPerMillion: 2, outputPerMillion: 10 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-5-5": { inputPerMillion: 0.1, outputPerMillion: 0.5 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
};

/** The cost in US dollars of `tokens` on `model`, or null when its price is unknown. */
export function costUsd(model: string, tokens: TokenCount, configured: Prices = {}): number | null {
  const price = configured[model] ?? builtInPrices[model];
  if (!price) return null;
  return (tokens.input * price.inputPerMillion + tokens.output * price.outputPerMillion) / 1_000_000;
}

const priceKeys = ["inputPerMillion", "outputPerMillion"] as const;

export function parsePricesSection(raw: unknown, ctx: SectionContext): Prices {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) ctx.fail("", 'must map model ids to { "inputPerMillion": …, "outputPerMillion": … }');
  const prices: Record<string, ModelPrice> = {};
  for (const [model, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPlainObject(entry)) ctx.fail(model, 'must be { "inputPerMillion": …, "outputPerMillion": … } in US dollars');
    const price = entry as Record<string, unknown>;
    for (const key of Object.keys(price)) {
      if (!(priceKeys as readonly string[]).includes(key)) ctx.fail(`${model}.${key}`, `is not a known setting (known: ${priceKeys.join(", ")})`);
    }
    for (const key of priceKeys) {
      const value = price[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        ctx.fail(`${model}.${key}`, "must be a non-negative number of US dollars per million tokens");
      }
    }
    prices[model] = { inputPerMillion: price.inputPerMillion as number, outputPerMillion: price.outputPerMillion as number };
  }
  return prices;
}
