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
