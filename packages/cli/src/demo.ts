import { allAdapters } from "@sessionlore/adapters";
import { App, storePath, type Clock, type Embedder, type ModelProvider } from "@sessionlore/core";
import { demoTopic, demoTopics, FixtureHome, writeDemoHarnessData } from "@sessionlore/fixtures";
import { allRenderers } from "@sessionlore/renderers";
import { MockLanguageModelV4 } from "ai/test";

/**
 * `sessionlore demo`: the dashboard on a made-up history, so a visitor can see
 * sessionlore working without their own Sessions or a Model Provider.
 *
 * Each run writes the demo dataset (the fixture builders' Claude Code and
 * Cursor Sessions) into a fresh throwaway home directory and runs the real
 * scan, Analysis and `suggest` on it into that home's own store, so the demo
 * never reads or writes the person's Harness data or store. Analysis results
 * come from a scripted Model Provider and Embedder that follow the dataset's
 * script (`demoTopics`): deterministic, offline, and nothing is downloaded.
 */

export interface DemoOptions {
  /** Folder the demo's throwaway home directory is created in. */
  root: string;
  clock: Clock;
}

export interface Demo {
  app: App;
  /** The demo's home directory: its Harness data, store, and anything accepting a Suggestion writes. */
  home: string;
  /** Closes the store and removes the demo's home directory. */
  close(): void;
}

export async function openDemo({ root, clock }: DemoOptions): Promise<Demo> {
  const home = FixtureHome.create("sessionlore-demo-", root);
  let app: App | undefined;
  try {
    writeDemoHarnessData(home, clock.now());
    app = App.open({
      storePath: storePath(home.path),
      // Only the demo home: nothing from the person's environment points the Adapters elsewhere.
      harnessContext: { homeDir: home.path, env: { HOME: home.path } },
      adapters: allAdapters,
      clock,
      modelProvider: demoModelProvider(),
      embedder: demoEmbedder(),
      renderers: allRenderers,
    });
    await app.scan();
    const analysis = await app.analyze();
    if (analysis.failed.length > 0) throw new Error(`The demo's Analysis failed: ${analysis.failed[0]!.error}`);
    const suggested = await app.suggest();
    if (suggested.failed.length > 0) throw new Error(`The demo's Suggestions failed: ${suggested.failed[0]!.error}`);
  } catch (error) {
    app?.close();
    home.remove();
    throw error;
  }
  const opened = app;
  return {
    app: opened,
    home: home.path,
    close() {
      opened.close();
      home.remove();
    },
  };
}

/**
 * Embeds every text that belongs to a demo topic onto that topic's axis, and
 * every other text onto its own pseudo-random direction, so Clusters form
 * exactly along the script's topics.
 */
function demoEmbedder(): Embedder {
  const randomDims = 64;
  const topicDims = demoTopics.length;
  return {
    modelId: "sessionlore-demo-embedder",
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array<number>(topicDims + randomDims).fill(0);
        const topic = demoTopic(text);
        if (topic) {
          vector[demoTopics.indexOf(topic)] = 1;
          return vector;
        }
        let seed = hash(text);
        for (let i = 0; i < randomDims; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          vector[topicDims + i] = seed / 2 ** 32 - 0.5;
        }
        const norm = Math.hypot(...vector);
        return vector.map((v) => v / norm);
      });
    },
  };
}

/**
 * Answers Analysis requests the way the demo's script says: a User Message
 * starting "no," is a Correction and one starting "also" a Follow-up of the
 * Task before it; Clusters are named after their topic; each Workflow and
 * Correction Cluster gets its topic's Skill or Rule.
 */
function demoModelProvider(): ModelProvider {
  const model = (modelId: string) =>
    new MockLanguageModelV4({
      modelId,
      doGenerate: async (options) => ({
        content: [{ type: "text", text: JSON.stringify(demoReply(JSON.stringify(options.prompt))) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 0, text: 0, reasoning: undefined },
        },
        warnings: [],
      }),
    });
  return { cheap: model("sessionlore-demo"), strong: model("sessionlore-demo") };
}

function demoReply(request: string): object {
  const named = /<(workflow|correction-cluster) name=\\"([^\\]*)\\"/.exec(request);
  if (named) {
    const topic = demoTopic(named[2]!) ?? demoTopic(request);
    const reply = named[1] === "workflow" ? topic?.skill : topic?.rule;
    if (!reply) throw new Error(`The demo has no ${named[1]} script for "${named[2]}"`);
    return reply;
  }
  const messages = [...request.matchAll(/<message index=\\"(\d+)\\">\\n([\s\S]*?)\\n<\/message>/g)];
  if (messages.length === 0) return { name: demoTopic(request)?.name ?? "Other work" };
  const tasks: { title: string; messages: { index: number; intent: string }[] }[] = [];
  for (const [, index, text] of messages) {
    const intent = text!.startsWith("no,") ? "Correction" : text!.startsWith("also") ? "Follow-up" : "New Task";
    if (intent === "New Task" || tasks.length === 0) tasks.push({ title: text!, messages: [] });
    tasks.at(-1)!.messages.push({ index: Number(index), intent });
  }
  return { tasks };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}
