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

describe("analyze without a Model Provider", () => {
  it("explains what to configure and exits non-zero, while scan still works", async () => {
    const repo = home.gitRepo("code/shop");
    writeClaudeSession(home, { cwd: repo, startedAt: "2026-05-01T09:00:00.000Z", turns: [turn.user("hi")] });

    const scan = await runCli(home, ["scan"]);
    expect(scan.exitCode).toBe(0);

    const analyze = await runCli(home, ["analyze"]);
    expect(analyze.exitCode).not.toBe(0);
    expect(analyze.stderr).toContain("No Model Provider is configured");
    expect(analyze.stderr).toContain(home.resolve(".sessionlore/config.json"));
    expect(analyze.stderr).toContain("cheapModel");
    expect(analyze.stderr).toContain("SESSIONLORE_API_KEY");
  });

  it("names the missing API key when the config file chooses a provider that needs one", async () => {
    writeConfig(home, {
      modelProvider: { provider: "anthropic", cheapModel: "claude-haiku-4-5", strongModel: "claude-sonnet-4-5" },
    });

    const analyze = await runCli(home, ["analyze"]);

    expect(analyze.exitCode).not.toBe(0);
    expect(analyze.stderr).toContain("No API key found for the anthropic Model Provider");
    expect(analyze.stderr).toContain("ANTHROPIC_API_KEY");
  });

  it("names the problem in an invalid Model Provider configuration", async () => {
    const analyze = await runCli(home, ["analyze"], {
      env: { SESSIONLORE_PROVIDER: "skynet", SESSIONLORE_CHEAP_MODEL: "x", SESSIONLORE_STRONG_MODEL: "y" },
    });

    expect(analyze.exitCode).not.toBe(0);
    expect(analyze.stderr).toContain("The Model Provider configuration is invalid");
    expect(analyze.stderr).toContain("provider");
  });
});

const apiKey = "sk-ant-api03-Zx9Qw2Lm7Rt4Vb8Nc1Kp5Hy3Jd6Fg0Ss";
const dbPassword = "hunter2-Tr0ub4dor";
const privateKey = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
  "QyNTUxOQAAACDkV7fH2pQx9Lm3Rt8Vb2Nc6Kp1Hy4Jd7Fg0SsZx5QwAAAAJiYc3LYmHNy2A",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");
const highEntropy = "q8Vz3Lr9Tx2Mw7Kp4Nb6Hc1Jf5Gd0Sa";

function writeSessionWithSecrets(repo: string) {
  return writeClaudeSession(home, {
    cwd: repo,
    startedAt: "2026-05-01T09:00:00.000Z",
    turns: [
      turn.user(`call the API with ANTHROPIC_API_KEY=${apiKey}`),
      turn.assistant("Done."),
      turn.user(`connect to postgres://admin:${dbPassword}@db.internal:5432/shop instead`),
      turn.user(`deploy with this key:\n${privateKey}\nand session token ${highEntropy}`),
    ],
  });
}

const oneTask = {
  tasks: [
    {
      title: "Wire up the API",
      messages: [
        { index: 0, intent: "New Task" },
        { index: 1, intent: "Correction" },
        { index: 2, intent: "Follow-up" },
      ],
    },
  ],
};

describe("redaction", () => {
  it("never sends planted secrets to the Model Provider", async () => {
    writeSessionWithSecrets(home.gitRepo("code/shop"));
    const provider = scriptedModelProvider(() => oneTask);

    await runCli(home, ["scan"]);
    const analyze = await runCli(home, ["analyze"], { modelProvider: provider.modelProvider });
    expect(analyze.exitCode).toBe(0);

    const sent = provider.requests().join("\n");
    expect(provider.requests()).toHaveLength(1);
    expect(sent).toContain("call the API with");
    for (const secret of [apiKey, dbPassword, "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", highEntropy]) {
      expect(sent).not.toContain(secret);
    }
    expect(sent).toContain("[REDACTED:api-key]");
    expect(sent).toContain("[REDACTED:password]");
    expect(sent).toContain("[REDACTED:private-key]");
    expect(sent).toContain("[REDACTED:high-entropy]");
  });

  it("`analyze --show-redacted <session>` prints the redacted text that would be sent, without calling the Model Provider", async () => {
    const session = writeSessionWithSecrets(home.gitRepo("code/shop"));
    await runCli(home, ["scan"]);

    const shown = await runCli(home, ["analyze", "--show-redacted", session.id]);

    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain(
      '<message index="1">\nconnect to postgres://admin:[REDACTED:password]@db.internal:5432/shop instead\n</message>',
    );
    expect(shown.stdout).toContain("call the API with ANTHROPIC_API_KEY=[REDACTED:api-key]");
    expect(shown.stdout).toContain("deploy with this key:\n[REDACTED:private-key]\nand session token [REDACTED:high-entropy]");
    for (const secret of [apiKey, dbPassword, highEntropy]) expect(shown.stdout).not.toContain(secret);
  });

  it("`analyze --show-redacted` names an unknown Session", async () => {
    const shown = await runCli(home, ["analyze", "--show-redacted", "no-such-session"]);

    expect(shown.exitCode).not.toBe(0);
    expect(shown.stderr).toContain("No Session with id no-such-session");
  });
});

describe("analyze and excluded Projects", () => {
  it("neither analyzes nor shows Sessions of a Project excluded after they were scanned", async () => {
    const shop = home.gitRepo("code/shop");
    const secret = home.gitRepo("code/secret-client");
    const kept = writeClaudeSession(home, { cwd: shop, startedAt: "2026-05-01T09:00:00.000Z", turns: [turn.user("add tests")] });
    writeClaudeSession(home, { cwd: secret, startedAt: "2026-05-02T09:00:00.000Z", turns: [turn.user("audit payroll")] });
    const reply = { tasks: [{ title: "Do it", messages: [{ index: 0, intent: "New Task" }] }] };
    const provider = scriptedModelProvider(() => reply);

    await runCli(home, ["scan"]);
    writeConfig(home, { projects: { exclude: ["secret-client"] } });
    await runCli(home, ["analyze"], { modelProvider: provider.modelProvider });

    expect(provider.requests().join("\n")).not.toContain("payroll");
    const { sessions } = (await runCli(home, ["tasks", "--json"])).json();
    expect(sessions.map((s: any) => s.id)).toEqual([kept.id]);
  });
});

describe("analyze with a malformed reply", () => {
  it("reports the failure for that Session, analyzes the others, and retries it on the next Analysis", async () => {
    const repo = home.gitRepo("code/shop");
    const good = writeClaudeSession(home, {
      cwd: repo,
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [turn.user("rename the cart module")],
    });
    const bad = writeClaudeSession(home, {
      cwd: repo,
      startedAt: "2026-05-02T09:00:00.000Z",
      turns: [turn.user("bump the node version"), turn.user("and the lockfile")],
    });
    const renamed = { tasks: [{ title: "Rename the cart module", messages: [{ index: 0, intent: "New Task" }] }] };
    let badReply: object | string = "Sure! Here are the tasks: bump node, update lockfile.";
    const provider = scriptedModelProvider((request) => (request.includes("cart") ? renamed : badReply));

    await runCli(home, ["scan"]);
    const analyze = await runCli(home, ["analyze"], { modelProvider: provider.modelProvider });

    expect(analyze.exitCode).toBe(0);
    expect(analyze.stdout).toContain("1 Session analyzed");
    expect(analyze.stdout).toContain("1 Session failed");
    expect(analyze.stdout).toContain(bad.id);
    const { sessions } = (await runCli(home, ["tasks", "--json"])).json();
    expect(sessions.map((s: any) => s.id)).toEqual([good.id]);

    // A reply that leaves a User Message out is malformed too.
    badReply = { tasks: [{ title: "Bump Node", messages: [{ index: 0, intent: "New Task" }] }] };
    const json = (await runCli(home, ["analyze", "--json"], { modelProvider: provider.modelProvider })).json();
    expect(json.analyzed).toEqual([]);
    expect(json.failed).toEqual([{ session: bad.id, error: expect.stringContaining("without an Intent") }]);

    badReply = {
      tasks: [
        {
          title: "Bump Node",
          messages: [
            { index: 0, intent: "New Task" },
            { index: 1, intent: "Follow-up" },
          ],
        },
      ],
    };
    const retry = (await runCli(home, ["analyze", "--json"], { modelProvider: provider.modelProvider })).json();
    expect(retry).toEqual({ analyzed: [bad.id], failed: [] });
    expect(provider.requests()).toHaveLength(4);
  });
});

describe("analyze with a Model Provider", () => {
  it("splits each Session into Tasks so that `tasks --json` lists each User Message's Intent", async () => {
    const repo = home.gitRepo("code/shop");
    const checkout = writeClaudeSession(home, {
      cwd: repo,
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [
        turn.user("add a checkout button"),
        turn.assistant("Added it."),
        turn.user("no, use the shared Button component"),
        turn.assistant("Switched."),
        turn.user("looks good"),
        turn.user("now add dark mode"),
        turn.assistant("Added dark mode."),
        turn.user("also make it the default"),
      ],
    });
    const flaky = writeClaudeSession(home, {
      cwd: repo,
      startedAt: "2026-05-02T09:00:00.000Z",
      turns: [turn.user("fix the flaky test"), turn.assistant("Which one?"), turn.user("I mean the login test")],
    });
    const provider = scriptedModelProvider((request) =>
      request.includes("checkout")
        ? {
            tasks: [
              {
                title: "Add a checkout button",
                messages: [
                  { index: 0, intent: "New Task" },
                  { index: 1, intent: "Correction" },
                  { index: 2, intent: "Approval" },
                ],
              },
              {
                title: "Add dark mode",
                messages: [
                  { index: 3, intent: "New Task" },
                  { index: 4, intent: "Follow-up" },
                ],
              },
            ],
          }
        : {
            tasks: [
              {
                title: "Fix the flaky login test",
                messages: [
                  { index: 0, intent: "New Task" },
                  { index: 1, intent: "Clarification" },
                ],
              },
            ],
          },
    );

    await runCli(home, ["scan"]);
    const analyze = await runCli(home, ["analyze"], { modelProvider: provider.modelProvider });
    expect(analyze.exitCode).toBe(0);
    expect(analyze.stdout).toContain("2 Sessions analyzed");

    const tasks = await runCli(home, ["tasks", "--json"]);
    expect(tasks.exitCode).toBe(0);
    expect(tasks.json()).toEqual({
      sessions: [
        {
          id: flaky.id,
          harness: "claude-code",
          project: { name: "shop", path: repo },
          tasks: [
            {
              title: "Fix the flaky login test",
              userMessages: [
                { text: "fix the flaky test", intent: "New Task" },
                { text: "I mean the login test", intent: "Clarification" },
              ],
            },
          ],
        },
        {
          id: checkout.id,
          harness: "claude-code",
          project: { name: "shop", path: repo },
          tasks: [
            {
              title: "Add a checkout button",
              userMessages: [
                { text: "add a checkout button", intent: "New Task" },
                { text: "no, use the shared Button component", intent: "Correction" },
                { text: "looks good", intent: "Approval" },
              ],
            },
            {
              title: "Add dark mode",
              userMessages: [
                { text: "now add dark mode", intent: "New Task" },
                { text: "also make it the default", intent: "Follow-up" },
              ],
            },
          ],
        },
      ],
    });
  });
});
