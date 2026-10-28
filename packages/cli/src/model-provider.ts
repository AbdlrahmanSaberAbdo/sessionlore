import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  completeModelProviderSettings,
  modelProviderNames,
  type CompleteModelProviderSettings,
  type Env,
  type ModelProvider,
  type ModelProviderModel,
  type ModelProviderName,
  type ModelProviderSettings,
} from "@habitlore/core";
import { createOllama } from "ollama-ai-provider-v2";

/**
 * Builds the Model Provider from the config file's `modelProvider` section,
 * with `HABITLORE_*` environment variables taking precedence (ADR 0007).
 */

/** What habitlore knows about each provider, and how to build its models. */
interface ProviderSpec {
  /** The provider's own environment variable for its API key. */
  keyEnv?: string;
  needsKey: boolean;
  needsBaseURL?: boolean;
  models(settings: CompleteModelProviderSettings, apiKey: string | undefined): (id: string) => ModelProviderModel;
}

const providers: Record<ModelProviderName, ProviderSpec> = {
  anthropic: {
    keyEnv: "ANTHROPIC_API_KEY",
    needsKey: true,
    models: ({ baseURL }, apiKey) => createAnthropic({ apiKey, baseURL }),
  },
  openai: {
    keyEnv: "OPENAI_API_KEY",
    needsKey: true,
    models: ({ baseURL }, apiKey) => createOpenAI({ apiKey, baseURL }),
  },
  google: {
    keyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    needsKey: true,
    models: ({ baseURL }, apiKey) => createGoogleGenerativeAI({ apiKey, baseURL }),
  },
  ollama: {
    needsKey: false,
    models: ({ baseURL }) => createOllama({ baseURL: baseURL ?? "http://localhost:11434/api" }),
  },
  "openai-compatible": {
    needsKey: false,
    needsBaseURL: true,
    models: ({ baseURL }, apiKey) => {
      const provider = createOpenAICompatible({ name: "openai-compatible", baseURL: baseURL!, apiKey });
      return (id) => provider.chatModel(id);
    },
  },
};

export type ModelProviderResolution = { ok: true; modelProvider: ModelProvider } | { ok: false; problem: string };

/** `configFile` is only used to tell the person where to configure. */
export function resolveModelProvider(
  fromFile: ModelProviderSettings | null,
  env: Env,
  configFile: string,
): ModelProviderResolution {
  const fromEnv = withoutUndefined({
    provider: env.HABITLORE_PROVIDER,
    cheapModel: env.HABITLORE_CHEAP_MODEL,
    strongModel: env.HABITLORE_STRONG_MODEL,
    apiKey: env.HABITLORE_API_KEY,
    baseURL: env.HABITLORE_BASE_URL,
  });
  const merged = { ...fromFile, ...fromEnv };
  if (Object.keys(merged).length === 0) return { ok: false, problem: notConfiguredMessage(configFile) };

  const checked = completeModelProviderSettings(merged);
  if (!checked.ok) {
    const issues = checked.issues.map((issue) => `  - ${issue}`);
    return {
      ok: false,
      problem: `The Model Provider configuration is invalid:\n${issues.join("\n")}\n\n${notConfiguredMessage(configFile)}`,
    };
  }
  return build(checked.settings, env);
}

function build(settings: CompleteModelProviderSettings, env: Env): ModelProviderResolution {
  const spec = providers[settings.provider];
  const keyEnv = settings.apiKeyEnv ?? spec.keyEnv;
  const apiKey = settings.apiKey ?? (keyEnv ? env[keyEnv] : undefined);
  if (spec.needsKey && !apiKey) {
    const where = [keyEnv, "HABITLORE_API_KEY"].filter(Boolean).join(" or ");
    return {
      ok: false,
      problem: `No API key found for the ${settings.provider} Model Provider. Set ${where}, or "apiKey" under "modelProvider" in the config file.\n`,
    };
  }
  if (spec.needsBaseURL && !settings.baseURL) {
    return { ok: false, problem: `The ${settings.provider} Model Provider needs a "baseURL".\n` };
  }
  const model = spec.models(settings, apiKey);
  return { ok: true, modelProvider: { cheap: model(settings.cheapModel), strong: model(settings.strongModel) } };
}

function notConfiguredMessage(configFile: string): string {
  return `No Model Provider is configured, so Analysis cannot run. Scan still works without one.

Add a "modelProvider" section to ${configFile}:

  {
    "modelProvider": {
      "provider": "anthropic",
      "cheapModel": "claude-haiku-5-5",
      "strongModel": "claude-sonnet-5-5",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    }
  }

"provider" is one of ${modelProviderNames.join(", ")}. The API key comes from "apiKey", the variable named in "apiKeyEnv",
HABITLORE_API_KEY or the provider's own variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY);
Ollama needs none. HABITLORE_PROVIDER, HABITLORE_CHEAP_MODEL, HABITLORE_STRONG_MODEL and HABITLORE_BASE_URL
override the file, so you can also skip it entirely:

  export HABITLORE_PROVIDER=openai
  export HABITLORE_CHEAP_MODEL=gpt-5-mini
  export HABITLORE_STRONG_MODEL=gpt-5
  export HABITLORE_API_KEY=sk-...       # or OPENAI_API_KEY
  # HABITLORE_BASE_URL=...              # optional
`;
}

function withoutUndefined(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
