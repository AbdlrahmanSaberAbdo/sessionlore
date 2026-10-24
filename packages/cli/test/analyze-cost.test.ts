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

describe("analyze cost report", () => {
  // The scripted Model Provider reports 10 input and 20 output tokens per request.
  it("reports actual tokens and cost, using the price set in the config", async () => {
    writeSessions("add a checkout button", "fix the flaky test");
    writeConfig(home, { prices: { "mock-cheap": { inputPerMillion: 1000, outputPerMillion: 2000 } } });
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);

    const analyze = await runCli(home, ["analyze", "--yes"], { modelProvider: provider.modelProvider });

    expect(analyze.exitCode).toBe(0);
    expect(analyze.stdout).toMatch(/mock-cheap: about [\d,]+ input and [\d,]+ output tokens, about \$\d+\.\d\d/);
    // (20 × $1000 + 40 × $2000) / 1,000,000 = $0.10
    expect(analyze.stdout).toContain("Used: mock-cheap: 20 input and 40 output tokens, $0.10");
  });

  it("reports that the cost is unknown for a model with no known price", async () => {
    writeSessions("add a checkout button");
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);

    const analyze = await runCli(home, ["analyze", "--yes"], { modelProvider: provider.modelProvider });

    expect(analyze.stdout).toContain("cost unknown");
    expect(analyze.stdout).toContain("Used: mock-cheap: 10 input and 20 output tokens, cost unknown");
    expect(analyze.stdout).toContain('"prices"');
  });

  it("`--json` reports usage and cost per model", async () => {
    writeSessions("add a checkout button");
    writeConfig(home, { prices: { "mock-cheap": { inputPerMillion: 1000, outputPerMillion: 2000 } } });
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);

    const result = (await runCli(home, ["analyze", "--json", "--yes"], { modelProvider: provider.modelProvider })).json();

    expect(result.usage).toEqual([{ model: "mock-cheap", tokens: { input: 10, output: 20 }, costUsd: 0.05 }]);
  });

  it("names the problem in an invalid price", async () => {
    writeConfig(home, { prices: { "mock-cheap": { inputPerMillion: "cheap" } } });

    const sessions = await runCli(home, ["sessions"]);

    expect(sessions.exitCode).not.toBe(0);
    expect(sessions.stderr).toContain("prices.mock-cheap");
  });
});

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

  it("goes ahead after a yes", async () => {
    writeSessions("add a checkout button");
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);

    const analyze = await runCli(home, ["analyze"], { modelProvider: provider.modelProvider, answers: ["y"] });

    expect(analyze.exitCode).toBe(0);
    expect(analyze.stdout).toContain("1 Session analyzed");
    expect(provider.requests()).toHaveLength(1);
  });

  it("`--yes` runs without prompting, even with a terminal", async () => {
    writeSessions("add a checkout button");
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);

    const analyze = await runCli(home, ["analyze", "--yes"], { modelProvider: provider.modelProvider, answers: [] });

    expect(analyze.exitCode).toBe(0);
    expect(analyze.stdout).not.toContain("Continue?");
    expect(provider.requests()).toHaveLength(1);
  });

  it("without a terminal to ask on, asks for --yes and spends nothing", async () => {
    writeSessions("add a checkout button");
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);

    const analyze = await runCli(home, ["analyze"], { modelProvider: provider.modelProvider });

    expect(analyze.exitCode).not.toBe(0);
    expect(analyze.stderr).toContain("--yes");
    expect(provider.requests()).toHaveLength(0);
  });

  it("with no new or changed Sessions, neither asks nor calls the Model Provider", async () => {
    writeSessions("add a checkout button");
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);
    await runCli(home, ["analyze", "--yes"], { modelProvider: provider.modelProvider });

    const again = await runCli(home, ["analyze"], { modelProvider: provider.modelProvider, answers: [] });

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("No new or changed Sessions to analyze");
    expect(provider.requests()).toHaveLength(1);
  });
});
