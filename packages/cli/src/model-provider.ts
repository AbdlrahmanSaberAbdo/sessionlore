import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { dataDir, type Env, type ModelProvider, type ModelProviderModel } from "@sessionlore/core";
import { createOllama } from "ollama-ai-provider-v2";
import { z } from "zod";

/**
 * Builds the Model Provider from the `modelProvider` section of the config
 * file, with `SESSIONLORE_*` environment variables taking precedence (ADR 0007).
 */

const providerNames = ["anthropic", "openai", "google", "ollama", "openai-compatible"] as const;
type ProviderName = (typeof providerNames)[number];

/** The provider's own environment variable for its API key. */
const defaultKeyEnv: Partial<Record<ProviderName, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

const settingsSchema = z.object({
  provider: z.enum(providerNames),
  cheapModel: z.string().min(1),
  strongModel: z.string().min(1),
  apiKey: z.string().min(1).optional(),
  /** Name of the environment variable holding the API key. */
  apiKeyEnv: z.string().min(1).optional(),
  baseURL: z.string().url().optional(),
});

type Settings = z.infer<typeof settingsSchema>;

export type ModelProviderResolution = { ok: true; modelProvider: ModelProvider } | { ok: false; problem: string };

export function configPath(homeDir: string): string {
  return join(dataDir(homeDir), "config.json");
}

export function resolveModelProvider(homeDir: string, env: Env): ModelProviderResolution {
  const path = configPath(homeDir);
  let fromFile: Record<string, unknown> = {};
  if (existsSync(path)) {
    let config: unknown;
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      return { ok: false, problem: `${path} is not valid JSON: ${(error as Error).message}\n` };
    }
    const section = (config as { modelProvider?: unknown } | null)?.modelProvider;
    if (section !== undefined && (typeof section !== "object" || section === null || Array.isArray(section))) {
      return { ok: false, problem: `"modelProvider" in ${path} must be an object.\n` };
    }
    fromFile = (section as Record<string, unknown> | undefined) ?? {};
  }

  const fromEnv = withoutUndefined({
    provider: env.SESSIONLORE_PROVIDER,
    cheapModel: env.SESSIONLORE_CHEAP_MODEL,
    strongModel: env.SESSIONLORE_STRONG_MODEL,
    apiKey: env.SESSIONLORE_API_KEY,
    baseURL: env.SESSIONLORE_BASE_URL,
  });
  const merged = { ...fromFile, ...fromEnv };
  if (Object.keys(merged).length === 0) return { ok: false, problem: notConfiguredMessage(path) };

  const parsed = settingsSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "modelProvider"}: ${i.message}`);
    return {
      ok: false,
      problem: `The Model Provider configuration is invalid:\n${issues.join("\n")}\n\n${notConfiguredMessage(path)}`,
    };
  }
  return build(parsed.data, env);
}

function build(settings: Settings, env: Env): ModelProviderResolution {
  const keyEnv = settings.apiKeyEnv ?? defaultKeyEnv[settings.provider];
  const apiKey = settings.apiKey ?? (keyEnv ? env[keyEnv] : undefined);
  const needsKey = settings.provider !== "ollama" && settings.provider !== "openai-compatible";
  if (needsKey && !apiKey) {
    const where = [keyEnv, "SESSIONLORE_API_KEY"].filter(Boolean).join(" or ");
    return {
      ok: false,
      problem: `No API key found for the ${settings.provider} Model Provider. Set ${where}, or "apiKey" under "modelProvider" in the config file.\n`,
    };
  }
  if (settings.provider === "openai-compatible" && !settings.baseURL) {
    return { ok: false, problem: `The openai-compatible Model Provider needs a "baseURL".\n` };
  }

  const model = modelFactory(settings, apiKey);
  return { ok: true, modelProvider: { cheap: model(settings.cheapModel), strong: model(settings.strongModel) } };
}

function modelFactory(settings: Settings, apiKey: string | undefined): (id: string) => ModelProviderModel {
  const { baseURL } = settings;
  switch (settings.provider) {
    case "anthropic":
      return createAnthropic({ apiKey, baseURL });
    case "openai":
      return createOpenAI({ apiKey, baseURL });
    case "google":
      return createGoogleGenerativeAI({ apiKey, baseURL });
    case "ollama":
      return createOllama({ baseURL: baseURL ?? "http://localhost:11434/api" });
    case "openai-compatible": {
      const provider = createOpenAICompatible({ name: "openai-compatible", baseURL: baseURL!, apiKey });
      return (id) => provider.chatModel(id);
    }
  }
}

function notConfiguredMessage(path: string): string {
  return `No Model Provider is configured, so Analysis cannot run. Scan still works without one.

Add a "modelProvider" section to ${path}:

  {
    "modelProvider": {
      "provider": "anthropic",
      "cheapModel": "claude-haiku-4-5",
      "strongModel": "claude-sonnet-4-5",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    }
  }

"provider" is one of ${providerNames.join(", ")}. The API key comes from "apiKey", the variable named in "apiKeyEnv",
SESSIONLORE_API_KEY or the provider's own variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY);
Ollama needs none. SESSIONLORE_PROVIDER, SESSIONLORE_CHEAP_MODEL, SESSIONLORE_STRONG_MODEL and SESSIONLORE_BASE_URL
override the file.
`;
}

function withoutUndefined(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
