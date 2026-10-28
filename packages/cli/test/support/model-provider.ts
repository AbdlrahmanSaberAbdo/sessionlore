import type { ModelProvider } from "@habitlore/core";
import { MockLanguageModelV4 } from "ai/test";

/**
 * A fake Model Provider for Seam 1 tests: an AI SDK mock language model whose
 * replies are scripted per request. Every request it receives is recorded so
 * tests can check what would have left the machine.
 */

export type Reply = object | string;

export interface ScriptedModelProvider {
  modelProvider: ModelProvider;
  /** The full text of every request the Model Provider received, in order. */
  requests(): string[];
  /** The sampling settings of every request, in order. */
  settings(): { temperature?: number; topP?: number; topK?: number }[];
}

/**
 * `reply` sees the request's text and returns the structured reply (or raw text to send as-is).
 * `names` sets the model ids, for tests about a real model (its built-in price, say).
 */
export function scriptedModelProvider(
  reply: (request: string) => Reply,
  names: { cheap: string; strong: string } = { cheap: "mock-cheap", strong: "mock-strong" },
): ScriptedModelProvider {
  const received: string[] = [];
  const settings: { temperature?: number; topP?: number; topK?: number }[] = [];
  const model = (name: string) =>
    new MockLanguageModelV4({
      modelId: name,
      doGenerate: async (options) => {
        const request = JSON.stringify(options.prompt);
        received.push(request);
        settings.push({ temperature: options.temperature, topP: options.topP, topK: options.topK });
        const answer = reply(request);
        return {
          content: [{ type: "text", text: typeof answer === "string" ? answer : JSON.stringify(answer) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 20, text: 20, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
  return {
    modelProvider: { cheap: model(names.cheap), strong: model(names.strong) },
    requests: () => [...received],
    settings: () => [...settings],
  };
}
