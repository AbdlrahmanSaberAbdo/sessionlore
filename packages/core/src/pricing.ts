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

/**
 * First-party API list prices: Anthropic (cached 2026-10) and OpenAI standard tier, short context, uncached input
 * (developers.openai.com/api/docs/pricing, 2026-10-25). Other providers' prices come from the config.
 */
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

  "gpt-6-astra": { inputPerMillion: 10, outputPerMillion: 50 },
  "gpt-6.1-sol": { inputPerMillion: 2, outputPerMillion: 10 },
  "gpt-6-sol": { inputPerMillion: 2, outputPerMillion: 10 },
  "gpt-6-luna": { inputPerMillion: 0.1, outputPerMillion: 0.5 },
  "gpt-5.6-sol": { inputPerMillion: 4, outputPerMillion: 20 },
  "gpt-5.6-terra": { inputPerMillion: 2, outputPerMillion: 12 },
  "gpt-5.6-luna": { inputPerMillion: 0.2, outputPerMillion: 1.2 },
  "gpt-5.5": { inputPerMillion: 5, outputPerMillion: 30 },
  "gpt-5.5-pro": { inputPerMillion: 30, outputPerMillion: 180 },
  "gpt-5.4": { inputPerMillion: 2.5, outputPerMillion: 15 },
  "gpt-5.4-pro": { inputPerMillion: 30, outputPerMillion: 180 },
  "gpt-5.4-mini": { inputPerMillion: 0.75, outputPerMillion: 4.5 },
  "gpt-5.4-nano": { inputPerMillion: 0.2, outputPerMillion: 1.25 },
  "gpt-5.3-codex": { inputPerMillion: 1.75, outputPerMillion: 14 },
  "gpt-5.2": { inputPerMillion: 1.75, outputPerMillion: 14 },
  "gpt-5.2-pro": { inputPerMillion: 21, outputPerMillion: 168 },
  "gpt-5.1": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gpt-5": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2 },
  "gpt-5-nano": { inputPerMillion: 0.05, outputPerMillion: 0.4 },
  "gpt-5-pro": { inputPerMillion: 15, outputPerMillion: 120 },
  "gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  "gpt-4.1-nano": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-2024-05-13": { inputPerMillion: 5, outputPerMillion: 15 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "o4-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  "o3": { inputPerMillion: 2, outputPerMillion: 8 },
  "o3-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  "o3-pro": { inputPerMillion: 20, outputPerMillion: 80 },
  "o1": { inputPerMillion: 15, outputPerMillion: 60 },
  "o1-pro": { inputPerMillion: 150, outputPerMillion: 600 },
  "chat-latest": { inputPerMillion: 5, outputPerMillion: 30 },
};

/** A dated snapshot ("gpt-4.1-2025-04-14") is priced like its model unless it has a price of its own. */
const SNAPSHOT_DATE = /-\d{4}-\d{2}-\d{2}$/;

/** The cost in US dollars of `tokens` on `model`, or null when its price is unknown. */
export function costUsd(model: string, tokens: TokenCount, configured: Prices = {}): number | null {
  const base = model.replace(SNAPSHOT_DATE, "");
  const price = configured[model] ?? builtInPrices[model] ?? configured[base] ?? builtInPrices[base];
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
