import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome } from "@habitlore/fixtures";
import { localEmbedder, type TransformersModule } from "../src/local-embedder.js";

/**
 * The real Embedder wraps transformers.js. These tests replace only the
 * transformers.js module itself, so nothing is downloaded.
 */

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

function fakeTransformers() {
  const loads: { task: string; model: string; cacheDir: string | null | undefined }[] = [];
  const module: TransformersModule = {
    env: {},
    async pipeline(task, model) {
      loads.push({ task, model, cacheDir: module.env.cacheDir });
      return async (texts: string[]) => ({ tolist: () => texts.map((t) => [t.length, 1]) });
    },
  };
  return { module, loads };
}

describe("the local Embedder", () => {
  it("loads the model on first use only, caching it under ~/.habitlore/models, and says it is downloading", async () => {
    const transformers = fakeTransformers();
    const notices: string[] = [];
    const embedder = localEmbedder({
      homeDir: home.path,
      notify: (text) => notices.push(text),
      load: async () => transformers.module,
    });
    expect(transformers.loads).toEqual([]);

    expect(await embedder.embed(["abc", "de"])).toEqual([
      [3, 1],
      [2, 1],
    ]);
    expect(await embedder.embed(["f"])).toEqual([[1, 1]]);

    expect(transformers.loads).toEqual([
      { task: "feature-extraction", model: embedder.modelId, cacheDir: home.resolve(".habitlore/models") },
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Downloading");
    expect(notices[0]).toContain(home.resolve(".habitlore/models"));
  });

  it("does not announce a download when the model is already cached", async () => {
    const transformers = fakeTransformers();
    const notices: string[] = [];
    const embedder = localEmbedder({ homeDir: home.path, notify: (t) => notices.push(t), load: async () => transformers.module });
    mkdirSync(join(home.resolve(".habitlore/models"), embedder.modelId), { recursive: true });

    await embedder.embed(["abc"]);

    expect(notices).toEqual([]);
  });

  it("explains how to get transformers.js when it is not installed", async () => {
    const embedder = localEmbedder({
      homeDir: home.path,
      notify: () => {},
      load: async () => {
        throw Object.assign(new Error("Cannot find package '@huggingface/transformers'"), { code: "ERR_MODULE_NOT_FOUND" });
      },
    });

    await expect(embedder.embed(["abc"])).rejects.toThrow(/@huggingface\/transformers/);
  });
});
