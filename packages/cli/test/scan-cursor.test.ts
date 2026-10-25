import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bubble,
  cursorDatabasePath,
  FixtureHome,
  holdCursorDatabaseOpen,
  turn,
  writeClaudeSession,
  writeCursorDatabase,
} from "@sessionlore/fixtures";
import { snapshotTree } from "./support/files.js";
import { runCli } from "./support/harness.js";

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

describe("scan of Cursor Sessions", () => {
  it("lists Cursor Sessions with Harness, Project, timestamps, model and User Message count", async () => {
    const repo = home.gitRepo("code/shop");
    const {
      composerIds: [id],
    } = writeCursorDatabase(home, [
      {
        folder: repo,
        createdAt: "2026-05-01T09:00:00.000Z",
        stepSeconds: 60,
        model: "claude-sonnet-5-5",
        bubbles: [
          bubble.user("add a checkout button", { wrapped: true }),
          bubble.tool("edit_file_v2"),
          bubble.assistant("Added it."),
          bubble.user("use the shared Button component"),
        ],
      },
    ]);

    expect((await runCli(home, ["scan"])).exitCode).toBe(0);
    const list = await runCli(home, ["sessions", "--json"]);

    expect(list.json()).toEqual({
      sessions: [
        {
          id,
          harness: "cursor",
          project: { name: "shop", path: repo },
          startedAt: "2026-05-01T09:00:00.000Z",
          endedAt: "2026-05-01T09:03:00.000Z",
          model: "claude-sonnet-5-5",
          userMessageCount: 2,
          assistantTurnCount: 1,
          subagentRunCount: 0,
          tokens: { input: 10, output: 5, cacheCreation: 0, cacheRead: 0 },
        },
      ],
    });
  });

  it("shows User Messages, assistant messages and tool calls in order", async () => {
    const repo = home.gitRepo("code/shop");
    const {
      composerIds: [id],
    } = writeCursorDatabase(home, [
      {
        folder: repo,
        createdAt: "2026-05-01T09:00:00.000Z",
        stepSeconds: 60,
        bubbles: [
          bubble.user("run the tests", { wrapped: true }),
          bubble.thinking(),
          bubble.tool("run_terminal_command_v2", "completed"),
          bubble.tool("edit_file_v2", "rejected"),
          bubble.assistant("All 3 tests pass."),
          bubble.user("thanks"),
        ],
      },
    ]);

    await runCli(home, ["scan"]);
    const shown = await runCli(home, ["session", id!, "--json"]);

    expect(shown.exitCode).toBe(0);
    expect(shown.json().session.messages).toEqual([
      { role: "user", text: "run the tests", timestamp: "2026-05-01T09:00:00.000Z" },
      { role: "tool", name: "run_terminal_command_v2", status: "completed", timestamp: "2026-05-01T09:02:00.000Z" },
      { role: "tool", name: "edit_file_v2", status: "rejected", timestamp: "2026-05-01T09:03:00.000Z" },
      { role: "assistant", text: "All 3 tests pass.", timestamp: "2026-05-01T09:04:00.000Z" },
      { role: "user", text: "thanks", timestamp: "2026-05-01T09:05:00.000Z" },
    ]);
  });

  it("attaches a subagent composer to its parent Session instead of listing it", async () => {
    const repo = home.gitRepo("code/shop");
    writeCursorDatabase(home, [
      {
        id: "parent-composer",
        folder: repo,
        createdAt: "2026-05-01T09:00:00.000Z",
        stepSeconds: 60,
        bubbles: [
          bubble.user("find where prices are rounded"),
          bubble.tool("task_v2", "completed", { toolCallId: "call-explore" }),
          bubble.assistant("Prices are rounded in money.ts."),
        ],
      },
      {
        id: "subagent-composer",
        folder: repo,
        createdAt: "2026-05-01T09:01:10.000Z",
        stepSeconds: 5,
        subagentOf: { parentId: "parent-composer", toolCallId: "call-explore", typeName: "explore" },
        bubbles: [
          bubble.user("Search the codebase for price rounding."),
          bubble.tool("ripgrep_raw_search"),
          bubble.assistant("Found Math.round in money.ts."),
        ],
      },
    ]);

    await runCli(home, ["scan"]);
    const { sessions } = (await runCli(home, ["sessions", "--json"])).json();
    const { session } = (await runCli(home, ["session", "parent-composer", "--json"])).json();

    expect(sessions.map((s: any) => [s.id, s.userMessageCount, s.subagentRunCount])).toEqual([["parent-composer", 1, 1]]);
    expect(session.messages.map((m: any) => m.name ?? m.text)).toEqual([
      "find where prices are rounded",
      "task_v2",
      "Search the codebase for price rounding.",
      "ripgrep_raw_search",
      "Found Math.round in money.ts.",
      "Prices are rounded in money.ts.",
    ]);
    expect(session.messages[2]).toMatchObject({ role: "assistant", subagent: "explore" });
  });

  it("leaves the Cursor database unchanged", async () => {
    const repo = home.gitRepo("code/shop");
    writeCursorDatabase(home, [
      { folder: repo, createdAt: "2026-05-01T09:00:00.000Z", bubbles: [bubble.user("hi"), bubble.assistant("hello")] },
    ]);
    const before = snapshotTree(dirname(cursorDatabasePath(home)));

    expect((await runCli(home, ["scan"])).exitCode).toBe(0);

    expect(snapshotTree(dirname(cursorDatabasePath(home)))).toEqual(before);
  });

  it("scans while Cursor holds the database open", async () => {
    const repo = home.gitRepo("code/shop");
    writeCursorDatabase(home, [
      { folder: repo, createdAt: "2026-05-01T09:00:00.000Z", bubbles: [bubble.user("hi"), bubble.assistant("hello")] },
    ]);
    const cursor = holdCursorDatabaseOpen(home);
    try {
      const scan = await runCli(home, ["scan"]);
      expect(scan.stderr).toBe("");
      expect(scan.exitCode).toBe(0);
    } finally {
      cursor.close();
    }

    const { sessions } = (await runCli(home, ["sessions", "--json"])).json();
    expect(sessions).toHaveLength(1);
  });

  it("reports zero updated Cursor Sessions when nothing changed, and one when a Session changed", async () => {
    const repo = home.gitRepo("code/shop");
    const composers = [
      { id: "first", folder: repo, createdAt: "2026-05-01T09:00:00.000Z", bubbles: [bubble.user("one")] },
      { id: "second", folder: repo, createdAt: "2026-05-02T09:00:00.000Z", bubbles: [bubble.user("two")] },
    ];
    writeCursorDatabase(home, composers);

    const first = (await runCli(home, ["scan", "--json"])).json();
    const second = (await runCli(home, ["scan", "--json"])).json();
    writeCursorDatabase(home, [composers[0]!, { ...composers[1]!, bubbles: [bubble.user("two"), bubble.user("and more")] }]);
    const third = (await runCli(home, ["scan", "--json"])).json();

    const cursor = { harness: "cursor", name: "Cursor", warnings: [] };
    expect(first.harnesses).toEqual([{ ...cursor, added: 2, updated: 0, unchanged: 0 }]);
    expect(second.harnesses).toEqual([{ ...cursor, added: 0, updated: 0, unchanged: 2 }]);
    expect(third.harnesses).toEqual([{ ...cursor, added: 0, updated: 1, unchanged: 1 }]);
  });

  it("warns with a count about bubbles in an unknown format version instead of crashing or skipping them silently", async () => {
    const repo = home.gitRepo("code/shop");
    writeCursorDatabase(home, [
      {
        folder: repo,
        createdAt: "2026-05-01T09:00:00.000Z",
        bubbles: [
          bubble.user("hi"),
          bubble.assistant("hello", { version: 99 }),
          bubble.user("more", { version: 99 }),
        ],
      },
    ]);

    const text = await runCli(home, ["scan"]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toMatch(/Cursor: skipped 2 records .*bubble format version 99: 2/);

    writeCursorDatabase(home, [
      { folder: repo, createdAt: "2026-05-02T09:00:00.000Z", bubbles: [bubble.user("again", { version: 99 })] },
    ]);
    const json = (await runCli(home, ["scan", "--json"])).json();
    expect(json.harnesses[0].warnings).toEqual([expect.stringMatching(/skipped 1 record .*bubble format version 99: 1/)]);
  });

  it("gives Claude Code and Cursor Sessions in the same git repository one Project", async () => {
    const repo = home.gitRepo("code/shop");
    const worktree = home.gitWorktree(repo, "code/shop-worktrees/feature-x");
    writeClaudeSession(home, { cwd: repo, startedAt: "2026-05-01T09:00:00.000Z", turns: [turn.user("hi")] });
    writeCursorDatabase(home, [{ folder: worktree, createdAt: "2026-05-02T09:00:00.000Z", bubbles: [bubble.user("hi")] }]);

    await runCli(home, ["scan"]);
    const { sessions } = (await runCli(home, ["sessions", "--json"])).json();

    expect(sessions.map((s: any) => [s.harness, s.project])).toEqual([
      ["cursor", { name: "shop", path: repo }],
      ["claude-code", { name: "shop", path: repo }],
    ]);
  });

  it("finds a Session's Project through Cursor's workspace mapping when its header names no folder", async () => {
    const repo = home.gitRepo("code/my shop");
    writeCursorDatabase(home, [
      {
        folder: repo,
        workspaceMapping: "workspace-json",
        createdAt: "2026-05-01T09:00:00.000Z",
        bubbles: [bubble.user("hi")],
      },
    ]);

    await runCli(home, ["scan"]);
    const { sessions } = (await runCli(home, ["sessions", "--json"])).json();

    expect(sessions[0].project).toEqual({ name: "my shop", path: repo });
  });

  it("finds the Project of a Session in a multi-root workspace from the folders its .code-workspace file lists", async () => {
    const repo = home.gitRepo("code/shop");
    const docs = home.gitRepo("code/shop-docs");
    writeCursorDatabase(home, [
      {
        folder: repo,
        workspaceMapping: "code-workspace",
        workspaceFolders: [repo, docs],
        createdAt: "2026-05-01T09:00:00.000Z",
        bubbles: [bubble.user("hi")],
      },
    ]);

    const scan = await runCli(home, ["scan"]);
    const { sessions } = (await runCli(home, ["sessions", "--json"])).json();

    expect(scan.stderr).toBe("");
    expect(sessions[0].project).toEqual({ name: "shop", path: repo });
  });

  it("reads Sessions from the older composer list, with a warning, when the database has no composerHeaders table", async () => {
    const repo = home.gitRepo("code/shop");
    writeCursorDatabase(
      home,
      [{ id: "old-composer", folder: repo, createdAt: "2026-05-01T09:00:00.000Z", bubbles: [bubble.user("add a cart"), bubble.assistant("Added.")] }],
      { headers: "legacy" },
    );

    const scan = await runCli(home, ["scan"]);
    const { sessions } = (await runCli(home, ["sessions", "--json"])).json();

    expect(scan.exitCode, scan.stderr).toBe(0);
    expect(scan.stderr).toMatch(/Warning: Cursor: .*composerHeaders/);
    expect(sessions.map((s: any) => [s.id, s.userMessageCount, s.project])).toEqual([["old-composer", 1, { name: "shop", path: repo }]]);
  });

  it("warns instead of failing when the database has neither composerHeaders nor the older composer list", async () => {
    writeClaudeSession(home, { cwd: home.gitRepo("code/shop"), startedAt: "2026-05-01T09:00:00.000Z", turns: [turn.user("hi")] });
    writeCursorDatabase(home, [{ folder: home.gitRepo("code/shop"), createdAt: "2026-05-01T09:00:00.000Z", bubbles: [bubble.user("hi")] }], {
      headers: "none",
    });

    const scan = await runCli(home, ["scan"]);
    const { sessions } = (await runCli(home, ["sessions", "--json"])).json();

    expect(scan.exitCode, scan.stderr).toBe(0);
    expect(scan.stderr).toMatch(/Warning: Cursor: .*composerHeaders.*please report this/);
    expect(sessions.map((s: any) => s.harness)).toEqual(["claude-code"]);
  });
});

describe("scan --harness", () => {
  function writeBoth() {
    const repo = home.gitRepo("code/shop");
    writeClaudeSession(home, { cwd: repo, startedAt: "2026-05-01T09:00:00.000Z", turns: [turn.user("add a checkout button")] });
    writeCursorDatabase(home, [{ folder: repo, createdAt: "2026-05-02T09:00:00.000Z", bubbles: [bubble.user("add a cart page")] }]);
  }
  const harnesses = async () =>
    (await runCli(home, ["sessions", "--json"])).json().sessions.map((s: any) => s.harness).sort();

  it("reads only the Harness it names", async () => {
    writeBoth();

    const scan = await runCli(home, ["scan", "--harness", "cursor", "--json"]);

    expect(scan.exitCode, scan.stderr).toBe(0);
    expect(scan.json().harnesses.map((h: any) => h.harness)).toEqual(["cursor"]);
    expect(await harnesses()).toEqual(["cursor"]);
  });

  it("takes several Harnesses, repeated or comma-separated", async () => {
    writeBoth();

    expect((await runCli(home, ["scan", "--harness", "claude-code", "--harness", "cursor"])).exitCode).toBe(0);
    expect(await harnesses()).toEqual(["claude-code", "cursor"]);
    const again = await runCli(home, ["scan", "--harness", "cursor,claude-code", "--json"]);
    expect(again.json().harnesses.map((h: any) => h.harness).sort()).toEqual(["claude-code", "cursor"]);
  });

  it("rejects a Harness sessionlore does not know", async () => {
    const result = await runCli(home, ["scan", "--harness", "vim"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("claude-code");
    expect(result.stderr).toContain("cursor");
  });
});
