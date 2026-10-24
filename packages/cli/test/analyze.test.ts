import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@sessionlore/fixtures";
import { runCli } from "./support/harness.js";
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
