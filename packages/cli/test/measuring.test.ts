import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@sessionlore/fixtures";
import { topicEmbedder } from "./support/embedder.js";
import { fixedClock, runCli, type RunOptions } from "./support/harness.js";
import { scriptedModelProvider } from "./support/model-provider.js";

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

/**
 * Labels User Messages by how they start: "no, ..." is a Correction in the
 * Task before it, anything else starts a New Task titled with its text.
 * Clusters are named after their topic; Workflows get a migration Skill.
 */
function modelProvider() {
  return scriptedModelProvider((request) => {
    if (request.includes("<workflow")) {
      return {
        title: "Write a database migration",
        trigger: "Use when adding or changing a database table.",
        steps: ["Create a migration file.", "Add a rollback."],
      };
    }
    const messages = [...request.matchAll(/<message index=\\"(\d+)\\">\\n([\s\S]*?)\\n<\/message>/g)];
    if (messages.length === 0) {
      return { name: request.includes("migration") ? "Write database migrations" : request.includes("release") ? "Write release notes" : "Other" };
    }
    const tasks: { title: string; messages: { index: number; intent: string }[] }[] = [];
    for (const [, index, text] of messages) {
      const intent = text!.startsWith("no,") ? "Correction" : "New Task";
      if (intent === "New Task" || tasks.length === 0) tasks.push({ title: text!, messages: [] });
      tasks.at(-1)!.messages.push({ index: Number(index), intent });
    }
    return { tasks };
  });
}

const now = fixedClock("2026-06-01T12:00:00.000Z");

function options(): RunOptions {
  return {
    modelProvider: modelProvider().modelProvider,
    embedder: topicEmbedder(["database migration", "release notes"]),
    clock: now,
  };
}

function session(cwd: string, startedAt: string, ...messages: string[]) {
  return writeClaudeSession(home, {
    cwd,
    startedAt,
    turns: messages.flatMap((m) => [turn.user(m), turn.assistant("Done.")]),
  });
}

async function analyze(opts: RunOptions) {
  expect((await runCli(home, ["scan"], opts)).exitCode).toBe(0);
  const analysis = await runCli(home, ["analyze", "--json", "--yes"], opts);
  expect(analysis.exitCode, analysis.stderr).toBe(0);
  expect(analysis.json().failed).toEqual([]);
}

/** A migration Workflow over April and May with 2, 1 and 0 Corrections in its Tasks. */
function migrationWorkflow(shop = home.gitRepo("code/shop")) {
  session(shop, "2026-04-20T09:00:00.000Z", "write a database migration for orders", "no, add a rollback", "no, name it after the table");
  session(shop, "2026-05-10T09:00:00.000Z", "add a database migration for users", "no, add a rollback");
  session(shop, "2026-05-20T09:00:00.000Z", "database migration for the cart table");
  return shop;
}

describe("Corrections per Task", () => {
  it("is shown for each Workflow in `workflows --json`, overall and per month", async () => {
    migrationWorkflow();
    const opts = options();
    await analyze(opts);

    const result = await runCli(home, ["workflows", "--json"], opts);

    expect(result.exitCode, result.stderr).toBe(0);
    const [workflow] = result.json().workflows;
    expect(workflow.name).toBe("Write database migrations");
    expect(workflow.tasks.map((t: any) => t.corrections)).toEqual([2, 1, 0]);
    expect(workflow.correctionsPerTask).toEqual({
      overall: 1,
      byMonth: [
        { month: "2026-04", tasks: 1, corrections: 2, correctionsPerTask: 2 },
        { month: "2026-05", tasks: 2, corrections: 1, correctionsPerTask: 0.5 },
      ],
    });
  });
});

async function stats(opts: RunOptions = {}, ...flags: string[]) {
  const result = await runCli(home, ["stats", "--json", ...flags], opts);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.json();
}

/** Analyzes the migration Workflow, writes its Skill Suggestion and accepts it on 2026-06-01. */
async function acceptMigrationSkill(opts: RunOptions) {
  const shop = migrationWorkflow();
  await analyze(opts);
  const suggested = await runCli(home, ["suggest", "--json", "--yes"], opts);
  const [id] = suggested.json().created;
  const accepted = await runCli(home, ["accept", String(id), "--json"], opts);
  expect(accepted.exitCode, accepted.stderr).toBe(0);
  const skillDir = join(shop, ".claude", "skills", "write-a-database-migration");
  return { shop, id, skillDir };
}

describe("Skill usage", () => {
  it("records a usage event when a Session after acceptance invokes the accepted Skill", async () => {
    const opts = options();
    const { shop, id, skillDir } = await acceptMigrationSkill(opts);
    const used = writeClaudeSession(home, {
      cwd: shop,
      startedAt: "2026-06-03T09:00:00.000Z",
      turns: [
        turn.user("add a table for invoices"),
        turn.skill("write-a-database-migration", skillDir),
        turn.assistant("Done."),
        turn.skill("some-other-skill", join(shop, ".claude", "skills", "some-other-skill")),
      ],
    });

    expect((await runCli(home, ["scan"], opts)).exitCode).toBe(0);
    const result = await stats(opts);

    expect(result.skills).toEqual([
      {
        suggestion: id,
        title: "Write a database migration",
        acceptedAt: "2026-06-01T12:00:00.000Z",
        uses: 1,
        lastUsedAt: expect.stringMatching(/^2026-06-03T/),
        sessions: [used.id],
      },
    ]);
  });

  it("doesn't count uses from before acceptance, or of a same-named Skill installed elsewhere", async () => {
    const opts = options();
    const { shop, skillDir } = await acceptMigrationSkill(opts);
    writeClaudeSession(home, {
      cwd: shop,
      startedAt: "2026-05-30T09:00:00.000Z",
      turns: [turn.user("add a table for invoices"), turn.skill("write-a-database-migration", skillDir)],
    });
    const blog = home.gitRepo("code/blog");
    const otherDir = join(blog, ".claude", "skills", "write-a-database-migration");
    writeClaudeSession(home, {
      cwd: blog,
      startedAt: "2026-06-03T09:00:00.000Z",
      turns: [turn.user("add a posts table"), turn.skill("write-a-database-migration", otherDir)],
    });

    expect((await runCli(home, ["scan"], opts)).exitCode).toBe(0);
    const [skill] = (await stats(opts)).skills;

    expect(skill).toMatchObject({ uses: 0, lastUsedAt: null, sessions: [] });
  });
});

describe("stats --export", () => {
  it("writes only counts, averages and Workflow names: no User Message text, file paths or Project paths", async () => {
    const opts = options();
    const { shop, skillDir } = await acceptMigrationSkill(opts);
    session(shop, "2026-05-21T09:00:00.000Z", "update the release notes in docs/CHANGELOG.md", "no, keep it under 10 lines");
    session(shop, "2026-05-22T09:00:00.000Z", "release notes for 2.0");
    writeClaudeSession(home, {
      cwd: shop,
      startedAt: "2026-06-03T09:00:00.000Z",
      turns: [turn.user("add a table for invoices"), turn.skill("write-a-database-migration", skillDir)],
    });
    await analyze(opts);

    const result = await runCli(home, ["stats", "--export"], opts);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json()).toEqual({
      exportedAt: "2026-06-01T12:00:00.000Z",
      counts: { sessions: 6, tasks: 6, corrections: 4, workflows: 1, acceptedSkills: 1, skillUses: 1 },
      correctionsPerTask: {
        overall: 0.67,
        byMonth: [
          { month: "2026-04", tasks: 1, corrections: 2, correctionsPerTask: 2 },
          { month: "2026-05", tasks: 4, corrections: 2, correctionsPerTask: 0.5 },
          { month: "2026-06", tasks: 1, corrections: 0, correctionsPerTask: 0 },
        ],
      },
      topWorkflows: [
        {
          name: "Write database migrations",
          tasks: 3,
          sessions: 3,
          correctionsPerTask: { overall: 1, byMonth: expect.any(Array) },
        },
      ],
    });
    for (const secret of [shop, home.path, "CHANGELOG", "release notes", "no, add a rollback", "invoices", "skills/"]) {
      expect(result.stdout).not.toContain(secret);
    }
  });

  it("replaces Workflow names with neutral labels with --anonymize", async () => {
    migrationWorkflow();
    const opts = options();
    await analyze(opts);

    const result = await runCli(home, ["stats", "--export", "--anonymize"], opts);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json().topWorkflows.map((w: any) => w.name)).toEqual(["Workflow 1"]);
    expect(result.stdout).not.toContain("migration");
  });
});
