import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@sessionlore/fixtures";
import { runCli, writeConfig } from "./support/harness.js";
import { scriptedModelProvider } from "./support/model-provider.js";

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

const oneTask = { tasks: [{ title: "Do it", messages: [{ index: 0, intent: "New Task" }] }] };

function writeSessions(...firstMessages: string[]) {
  const repo = home.gitRepo("code/shop");
  return firstMessages.map((text, i) =>
    writeClaudeSession(home, {
      cwd: repo,
      startedAt: `2026-05-0${i + 1}T09:00:00.000Z`,
      turns: [turn.user(text)],
    }),
  );
}

describe("analyze cost estimate", () => {
  it("shows an estimate and spends nothing when the person declines", async () => {
    writeSessions("add a checkout button", "fix the flaky test");
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);

    const analyze = await runCli(home, ["analyze"], { modelProvider: provider.modelProvider, answers: ["n"] });

    expect(analyze.stdout).toContain("2 Sessions to analyze");
    expect(analyze.stdout).toMatch(/mock-cheap: about [\d,]+ input and [\d,]+ output tokens/);
    expect(analyze.stdout).toContain("Continue?");
    expect(analyze.stdout).toContain("Nothing analyzed");
    expect(analyze.exitCode).toBe(0);
    expect(provider.requests()).toHaveLength(0);
  });
});
