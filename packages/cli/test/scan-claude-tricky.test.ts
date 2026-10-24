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
});
