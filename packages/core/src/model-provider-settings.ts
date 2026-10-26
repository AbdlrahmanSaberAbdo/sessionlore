import type { SectionContext } from "./config.js";

/**
 * The config file's `modelProvider` section (ADR 0007): which provider, the
 * cheap and strong model ids, and where the API key comes from. Every field
 * is optional in the file because `SESSIONLORE_*` environment variables can
 * supply or override them; `completeModelProviderSettings` checks the merged
 * result. Both apply the same rules to each field (`fieldProblem`).
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

/** Settings with everything a Model Provider needs to be built. */
export type CompleteModelProviderSettings = ModelProviderSettings & Required<Pick<ModelProviderSettings, "provider" | "cheapModel" | "strongModel">>;

const keys = ["provider", "cheapModel", "strongModel", "apiKey", "apiKeyEnv", "baseURL"] as const;
const required = ["provider", "cheapModel", "strongModel"] as const;

/** What is wrong with one setting's value, or null when it is fine. */
function fieldProblem(key: string, value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return "must be a non-empty string";
  if (key === "provider" && !(modelProviderNames as readonly string[]).includes(value.trim())) {
    return `must be one of ${modelProviderNames.join(", ")}`;
  }
  if (key === "baseURL" && !URL.canParse(value.trim())) return "must be a URL";
  return null;
}

export function parseModelProviderSection(raw: unknown, ctx: SectionContext): ModelProviderSettings | null {
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    ctx.fail("", `must be an object with ${keys.map((k) => `"${k}"`).join(", ")}`);
  }
  const section = raw as Record<string, unknown>;
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(section)) {
    if (!(keys as readonly string[]).includes(key)) ctx.fail(key, `is not a known setting (known: ${keys.join(", ")})`);
    const problem = fieldProblem(key, value);
    if (problem) ctx.fail(key, problem);
    settings[key] = (value as string).trim();
  }
  return settings as ModelProviderSettings;
}

/**
 * Checks settings merged from the config file and the environment: every
 * required setting is there and each one is valid. Issues name the setting.
 */
export function completeModelProviderSettings(
  settings: Record<string, string | undefined>,
): { ok: true; settings: CompleteModelProviderSettings } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  for (const key of required) if (settings[key] === undefined) issues.push(`${key}: is required`);
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    const problem = fieldProblem(key, value);
    if (problem) issues.push(`${key}: ${problem}`);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, settings: settings as unknown as CompleteModelProviderSettings };
}
