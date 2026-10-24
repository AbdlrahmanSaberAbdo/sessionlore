import type { SectionContext } from "./config.js";

/**
 * The config file's `modelProvider` section (ADR 0007): which provider, the
 * cheap and strong model ids, and where the API key comes from. Every field
 * is optional here because `SESSIONLORE_*` environment variables can supply
 * or override them; the CLI checks the merged result and builds the models.
 */

export const modelProviderNames = ["anthropic", "openai", "google", "ollama", "openai-compatible"] as const;
export type ModelProviderName = (typeof modelProviderNames)[number];

export interface ModelProviderSettings {
  provider?: ModelProviderName;
  cheapModel?: string;
  strongModel?: string;
  apiKey?: string;
  /** Name of the environment variable holding the API key. */
  apiKeyEnv?: string;
  baseURL?: string;
}

const keys = ["provider", "cheapModel", "strongModel", "apiKey", "apiKeyEnv", "baseURL"] as const;

export function parseModelProviderSection(raw: unknown, ctx: SectionContext): ModelProviderSettings | null {
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    ctx.fail("", `must be an object with ${keys.map((k) => `"${k}"`).join(", ")}`);
  }
  const section = raw as Record<string, unknown>;
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(section)) {
    if (!(keys as readonly string[]).includes(key)) ctx.fail(key, `is not a known setting (known: ${keys.join(", ")})`);
    if (typeof value !== "string" || value.trim() === "") ctx.fail(key, "must be a non-empty string");
    settings[key] = value.trim();
  }
  if (settings.provider !== undefined && !(modelProviderNames as readonly string[]).includes(settings.provider)) {
    ctx.fail("provider", `must be one of ${modelProviderNames.join(", ")}`);
  }
  return settings as ModelProviderSettings;
}
