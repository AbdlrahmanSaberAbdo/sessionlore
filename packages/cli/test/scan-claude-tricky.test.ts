import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@sessionlore/fixtures";
import { runCli } from "./support/harness.js";

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

async function scanAndList(args: string[] = []): Promise<any[]> {
  const scan = await runCli(home, ["scan", ...args]);
  expect(scan.exitCode).toBe(0);
  return (await runCli(home, ["sessions", "--json"])).json().sessions;
}

describe("scan of Claude Code Sessions: the tricky cases", () => {
  it("merges assistant records that share one message id and counts their token usage once", async () => {
    const repo = home.gitRepo("code/shop");
    writeClaudeSession(home, {
      cwd: repo,
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [
        turn.user("explain the checkout flow"),
        turn.splitAssistant(["Let me think.", "It goes cart, address, payment.", "Anything else?"], {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 1000,
        }),
      ],
    });

    const [session] = await scanAndList();

    expect(session.assistantTurnCount).toBe(1);
    expect(session.tokens).toEqual({ input: 100, output: 50, cacheCreation: 200, cacheRead: 1000 });
  });

  it("attaches a subagent transcript to its parent Session without counting the subagent's prompts", async () => {
    const repo = home.gitRepo("code/shop");
    const parent = writeClaudeSession(home, {
      cwd: repo,
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [
        turn.user("find where prices are rounded"),
        turn.subagent({
          description: "Search for rounding",
          prompt: "Find every place prices are rounded and report file paths.",
          turns: [
            turn.tool("Grep", { pattern: "round" }, "src/price.ts"),
            turn.user("Also check the tests folder."),
            turn.assistant("Rounding happens in src/price.ts.", { input_tokens: 7, output_tokens: 3 }),
          ],
          result: "Rounding happens in src/price.ts.",
        }),
        turn.assistant("Prices are rounded in src/price.ts."),
      ],
    });

    const sessions = await scanAndList();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: parent.id,
      userMessageCount: 1,
      subagentRunCount: 1,
      // Parent: the Agent tool call and the final reply (10/20 each). Subagent: Grep call (10/20) and reply (7/3).
      tokens: { input: 37, output: 63 },
    });
  });

  it("excludes command wrappers, meta records and other Harness-written text from User Messages", async () => {
    const repo = home.gitRepo("code/shop");
    writeClaudeSession(home, {
      cwd: repo,
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [
        turn.command("review", "src/cart.ts"),
        turn.meta("Base directory for this skill: /home/me/.claude/skills/review\n\nReview the file."),
        turn.assistant("The cart looks fine."),
        turn.user("<system-reminder>The user opened src/cart.ts</system-reminder>\nwhy is the total off by a cent?"),
        turn.assistant("Rounding."),
        turn.interrupted(),
        turn.command("cost"),
        turn.localCommandOutput("Total cost: $0.42"),
        turn.taskNotification("Background build finished"),
        turn.user("<system-reminder>Reminder: todo list is empty.</system-reminder>"),
      ],
    });

    await runCli(home, ["scan"]);
    const { sessions } = (await runCli(home, ["sessions", "--json"])).json();

    expect(sessions[0].userMessageCount).toBe(1);
  });

  it("follows the message tree, leaving out branches the conversation abandoned", async () => {
    const repo = home.gitRepo("code/shop");
    writeClaudeSession(home, {
      cwd: repo,
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [
        turn.user("rename the cart module"),
        turn.assistant("Renamed it to basket."),
        // The person edited their next message, so this branch was left behind.
        turn.abandoned([turn.user("now delete the old tests"), turn.assistant("Deleted them.")]),
        turn.user("now update the imports"),
        turn.assistant("Updated the imports."),
      ],
    });

    const [session] = await scanAndList();

    expect(session).toMatchObject({ userMessageCount: 2, assistantTurnCount: 2 });
  });
});
