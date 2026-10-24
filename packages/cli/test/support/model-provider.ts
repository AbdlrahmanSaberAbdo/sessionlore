import type { ModelProvider } from "@sessionlore/core";
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
}

/** `reply` sees the request's text and returns the structured reply (or raw text to send as-is). */
export function scriptedModelProvider(reply: (request: string) => Reply): ScriptedModelProvider {
  const received: string[] = [];
  const model = (name: string) =>
    new MockLanguageModelV4({
      modelId: name,
      doGenerate: async (options) => {
        const request = JSON.stringify(options.prompt);
        received.push(request);
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
  return { modelProvider: { cheap: model("mock-cheap"), strong: model("mock-strong") }, requests: () => [...received] };
}
