import { existsSync, renameSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@habitlore/fixtures";
import { runCli, writeConfig } from "./support/harness.js";

/**
 * habitlore was called sessionlore before it was published. Someone who ran
 * sessionlore keeps their data, their environment variables and the Rules it
 * wrote to CLAUDE.md.
 */

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

/** A home with one stored Session, laid out the way sessionlore left it. */
async function sessionloreHome(): Promise<void> {
  writeClaudeSession(home, {
    cwd: home.gitRepo("code/shop"),
    startedAt: "2026-05-01T09:00:00.000Z",
    turns: [turn.user("add a checkout button"), turn.assistant("Added it.")],
  });
  expect((await runCli(home, ["scan"])).exitCode).toBe(0);
  renameSync(home.resolve(".habitlore/habitlore.db"), home.resolve(".habitlore/sessionlore.db"));
  renameSync(home.resolve(".habitlore"), home.resolve(".sessionlore"));
}

describe("a data folder left by sessionlore", () => {
  it("moves to ~/.habitlore on first run, keeping its Sessions, and says so once", async () => {
    await sessionloreHome();

    const first = await runCli(home, ["sessions", "--json"]);

    expect(first.exitCode).toBe(0);
    expect(first.json().sessions).toHaveLength(1);
    expect(existsSync(home.resolve(".sessionlore"))).toBe(false);
    expect(existsSync(home.resolve(".habitlore/habitlore.db"))).toBe(true);
    expect(existsSync(home.resolve(".habitlore/sessionlore.db"))).toBe(false);
    expect(first.stderr).toBe(
      `Moved ${home.resolve(".sessionlore")} to ${home.resolve(".habitlore")}: sessionlore is now called habitlore.\n`,
    );

    const second = await runCli(home, ["sessions", "--json"]);
    expect(second.stderr).toBe("");
  });

  it("is left alone, with a note, when ~/.habitlore already exists", async () => {
    await sessionloreHome();
    writeConfig(home, {});

    const result = await runCli(home, ["sessions", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.json().sessions).toEqual([]);
    expect(existsSync(home.resolve(".sessionlore/sessionlore.db"))).toBe(true);
    expect(result.stderr).toBe(`Using ${home.resolve(".habitlore")}; left the old ${home.resolve(".sessionlore")} folder alone.\n`);
  });
});

describe("SESSIONLORE_* environment variables", () => {
  it("still choose the Model Provider when the HABITLORE_* ones are unset", async () => {
    const result = await runCli(home, ["analyze"], {
      env: { SESSIONLORE_PROVIDER: "anthropic", SESSIONLORE_CHEAP_MODEL: "x", SESSIONLORE_STRONG_MODEL: "y" },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("No API key found for the anthropic Model Provider");
  });

  it("give way to the HABITLORE_* ones", async () => {
    const result = await runCli(home, ["analyze"], {
      env: {
        HABITLORE_PROVIDER: "anthropic",
        SESSIONLORE_PROVIDER: "openai",
        SESSIONLORE_CHEAP_MODEL: "x",
        SESSIONLORE_STRONG_MODEL: "y",
      },
    });

    expect(result.stderr).toContain("No API key found for the anthropic Model Provider");
  });
});
