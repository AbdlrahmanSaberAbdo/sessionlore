import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@habitlore/fixtures";
import { topicEmbedder } from "./support/embedder.js";
import { openApi } from "./support/api.js";
import { snapshotTree } from "./support/files.js";
import { fixedClock, runCli, type RunOptions } from "./support/harness.js";
import { scriptedModelProvider } from "./support/model-provider.js";

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

const migrationSkill = {
  title: "Write a database migration",
  trigger: "Use when adding or changing a database table.",
  steps: ["Create a migration file in db/migrations.", "Run the migration locally.", "Add a rollback."],
};

const pnpmRule = { title: "Use pnpm", rule: "Use pnpm, never npm, to install packages and run scripts." };

/**
 * Splits Sessions into Tasks ("no, ..." is a Correction in the Task before
 * it), names Clusters after their topic, and writes `migrationSkill` or
 * `pnpmRule` when asked for a Skill or a Rule.
 */
function modelProvider() {
  return scriptedModelProvider((request) => {
    if (request.includes("<workflow")) return migrationSkill;
    if (request.includes("<correction-cluster")) return pnpmRule;
    const messages = [...request.matchAll(/<message index=\\"(\d+)\\">\\n([\s\S]*?)\\n<\/message>/g)];
    if (messages.length === 0) {
      return { name: request.includes("pnpm") ? "Use pnpm, not npm" : request.includes("migration") ? "Write database migrations" : "Other" };
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

function options(provider = modelProvider()): RunOptions & { requests(): string[] } {
  return {
    modelProvider: provider.modelProvider,
    embedder: topicEmbedder(["database migration", "pnpm", "release notes"]),
    clock: fixedClock("2026-06-01T12:00:00.000Z"),
    requests: provider.requests,
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

async function suggest(opts: RunOptions) {
  const result = await runCli(home, ["suggest", "--json", "--yes"], opts);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.json();
}

async function review(opts: RunOptions = {}) {
  const result = await runCli(home, ["review", "--json"], opts);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.json().suggestions;
}

function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Three database-migration Tasks across three Sessions in `shop`: a Workflow. */
function migrationWorkflow() {
  const shop = home.gitRepo("code/shop");
  session(shop, "2026-05-10T09:00:00.000Z", "write a database migration for orders");
  session(shop, "2026-05-20T09:00:00.000Z", "add a database migration for users");
  session(shop, "2026-05-25T09:00:00.000Z", "database migration for the cart table");
  return shop;
}

const ownedSkill = [
  "---",
  "name: db-migrations",
  'description: "How we write a database migration in this repo."',
  "allowed-tools: Bash",
  "---",
  "",
  "# DB migrations",
  "",
  "1. Create a migration file.",
  "",
].join("\n");

describe("an owned Skill that overlaps a Workflow", () => {
  it("becomes the Target of the Workflow's Suggestion, and the strong model sees its current content", async () => {
    const shop = migrationWorkflow();
    const skill = write(join(shop, ".claude", "skills", "db-migrations", "SKILL.md"), ownedSkill);
    const opts = options();
    await analyze(opts);

    await suggest(opts);

    const [suggestion] = await review();
    expect(suggestion.target).toEqual({ kind: "skill", path: skill, name: "db-migrations" });
    const [request] = opts.requests().filter((r) => r.includes("<workflow"));
    expect(request).toContain("1. Create a migration file.");
  });

  it("shows the change against the current file as a diff in review", async () => {
    const shop = migrationWorkflow();
    const skill = write(join(shop, ".claude", "skills", "db-migrations", "SKILL.md"), ownedSkill);
    const opts = options();
    await analyze(opts);
    await suggest(opts);

    const [suggestion] = await review();

    expect(suggestion.diff).toContain(`--- ${skill}`);
    expect(suggestion.diff).toContain(`+++ ${skill}`);
    expect(suggestion.diff).toContain("-1. Create a migration file.");
    expect(suggestion.diff).toContain("+1. Create a migration file in db/migrations.");
    expect(suggestion.diff).toContain("+3. Add a rollback.");
    expect(suggestion.diff).not.toContain("-name: db-migrations");
    const human = await runCli(home, ["review"], opts);
    expect(human.stdout).toContain("+3. Add a rollback.");
    expect(human.stdout).toContain(`Updates ${skill}`);
  });

  it("is updated in place on accept, keeping its name and other frontmatter, with a backup restore brings back", async () => {
    const shop = migrationWorkflow();
    const skill = write(join(shop, ".claude", "skills", "db-migrations", "SKILL.md"), ownedSkill);
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;

    const accepted = await runCli(home, ["accept", String(id), "--json"], opts);

    expect(accepted.exitCode, accepted.stderr).toBe(0);
    expect(accepted.json().files).toEqual([{ path: skill, content: expect.any(String) }]);
    expect(accepted.json().backups).toEqual([{ path: skill }]);
    expect(existsSync(join(shop, ".claude", "skills", "write-a-database-migration"))).toBe(false);
    const updated = readFileSync(skill, "utf8");
    expect(updated).toMatch(/^---\nname: db-migrations\n/);
    expect(updated).toContain("allowed-tools: Bash\n");
    expect(updated).toContain("3. Add a rollback.");

    const restored = await runCli(home, ["restore", String(id), "--json"], opts);

    expect(restored.exitCode, restored.stderr).toBe(0);
    expect(restored.json().files).toEqual([skill]);
    expect(readFileSync(skill, "utf8")).toBe(ownedSkill);
    const again = await runCli(home, ["restore", String(id)], opts);
    expect(again.exitCode).not.toBe(0);
    expect(again.stderr).toContain("already restored");
  });

  it("is not a Target when it covers different ground", async () => {
    const shop = migrationWorkflow();
    write(join(shop, ".claude", "skills", "notes", "SKILL.md"), '---\nname: notes\ndescription: "Write the release notes."\n---\n\nBody\n');
    const opts = options();
    await analyze(opts);

    await suggest(opts);

    const [suggestion] = await review();
    expect(suggestion.target).toBeNull();
    expect(suggestion.diff).toBeNull();
  });

  it("can be a User scope skill in the home directory", async () => {
    migrationWorkflow();
    const skill = write(home.resolve(".claude/skills/db-migrations/SKILL.md"), ownedSkill);
    const opts = options();
    await analyze(opts);

    await suggest(opts);

    const [suggestion] = await review();
    expect(suggestion.target).toEqual({ kind: "skill", path: skill, name: "db-migrations" });
    expect(suggestion.scope).toEqual({ kind: "user" });
  });

  it("is no longer the Target once the Suggestion is moved to another Scope: it installs there as a new Skill", async () => {
    const shop = migrationWorkflow();
    const skill = write(join(shop, ".claude", "skills", "db-migrations", "SKILL.md"), ownedSkill);
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;

    const scoped = await runCli(home, ["scope", String(id), "user"], opts);
    const scopedJson = (await runCli(home, ["review", "--json"], opts)).json().suggestions[0];

    expect(scoped.exitCode, scoped.stderr).toBe(0);
    expect(scoped.stdout).toContain(`no longer updates ${skill}`);
    expect(scopedJson).toMatchObject({ target: null, scope: { kind: "user" }, diff: null });
    const review = await runCli(home, ["review"], opts);
    expect(review.stdout).not.toContain(`Updates ${skill}`);
    const accepted = (await runCli(home, ["accept", String(id), "--json"], opts)).json();
    expect(accepted.files.map((f: any) => f.path)).toEqual([home.resolve(".claude/skills/write-a-database-migration/SKILL.md")]);
    expect(readFileSync(skill, "utf8")).toBe(ownedSkill);
  });

  it("stays the Target when the Suggestion is scoped to the Project the Target is in", async () => {
    const shop = migrationWorkflow();
    const skill = write(join(shop, ".claude", "skills", "db-migrations", "SKILL.md"), ownedSkill);
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;

    const scoped = await runCli(home, ["scope", String(id), "project", "--json"], opts);

    expect(scoped.exitCode, scoped.stderr).toBe(0);
    expect(scoped.json()).toMatchObject({ suggestion: { target: { path: skill } }, droppedTarget: null });
  });

  it("is dropped by changing the Scope through the dashboard too, and the review shows the new file", async () => {
    const shop = migrationWorkflow();
    write(join(shop, ".claude", "skills", "db-migrations", "SKILL.md"), ownedSkill);
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;
    const api = openApi(home, opts);
    try {
      const scoped = await api.send("PUT", `/api/suggestions/${id}/scope`, { kind: "user" });
      const shown = (await api.get(`/api/suggestions/${id}`)).json();

      expect(scoped.json().target).toBeNull();
      expect(shown.changes).toEqual([
        expect.objectContaining({ path: home.resolve(".claude/skills/write-a-database-migration/SKILL.md"), before: null }),
      ]);
    } finally {
      api.close();
    }
  });
});

describe("an Accepted Suggestion whose Workflow keeps growing", () => {
  it("gets an update that targets the Skill it installed once the Workflow has grown meaningfully", async () => {
    const shop = migrationWorkflow();
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;
    expect((await runCli(home, ["accept", String(id)], opts)).exitCode).toBe(0);
    const installed = join(shop, ".claude", "skills", "write-a-database-migration", "SKILL.md");

    session(shop, "2026-05-28T09:00:00.000Z", "one more database migration for invoices");
    await analyze(opts);
    expect((await suggest(opts)).created).toEqual([]);

    session(shop, "2026-05-29T09:00:00.000Z", "database migration for refunds");
    await analyze(opts);
    const grown = await suggest(opts);

    expect(grown.created).toHaveLength(1);
    expect(grown.replaced).toEqual([]);
    const [update] = await review();
    expect(update.target).toEqual({ kind: "skill", path: installed, name: "write-a-database-migration" });
    expect(update.evidence).toHaveLength(5);
    expect((await suggest(opts)).created).toEqual([]);
  });

  it("gets an update that targets the line it added to CLAUDE.md", async () => {
    const shop = home.gitRepo("code/shop");
    session(shop, "2026-05-10T09:00:00.000Z", "fix the build", "no, use pnpm not npm to run it");
    session(shop, "2026-05-20T09:00:00.000Z", "update the release notes", "no, we use pnpm here");
    session(shop, "2026-05-25T09:00:00.000Z", "add a test", "no, pnpm please");
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;
    expect((await runCli(home, ["accept", String(id)], opts)).exitCode).toBe(0);

    session(shop, "2026-05-28T09:00:00.000Z", "bump a dependency", "no, with pnpm");
    session(shop, "2026-05-29T09:00:00.000Z", "run the linter", "no, pnpm lint");
    await analyze(opts);
    const grown = await suggest(opts);

    expect(grown.created).toHaveLength(1);
    const [update] = await review();
    expect(update.target).toEqual({
      kind: "rule",
      path: join(shop, "CLAUDE.md"),
      line: "- Use pnpm, never npm, to install packages and run scripts.",
    });
  });
});

describe("a plugin skill that overlaps a Workflow", () => {
  it("is never a Target: a companion Skill is suggested instead and the plugin's files stay untouched", async () => {
    const shop = migrationWorkflow();
    const pluginDir = home.resolve(".claude/plugins/cache/acme-market/dbtools/1.2.0");
    write(
      join(pluginDir, "skills", "migrate", "SKILL.md"),
      '---\nname: migrate\ndescription: "Run a database migration with dbtools."\n---\n\nUse dbtools.\n',
    );
    const before = snapshotTree(home.resolve(".claude/plugins"));
    const opts = options();
    await analyze(opts);

    const [id] = (await suggest(opts)).created;

    const [suggestion] = await review();
    expect(suggestion.target).toBeNull();
    expect(suggestion.companionOf).toEqual({ plugin: "dbtools", name: "migrate" });
    const [request] = opts.requests().filter((r) => r.includes("<workflow"));
    expect(request).toContain("Run a database migration with dbtools.");

    const accepted = await runCli(home, ["accept", String(id)], opts);
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    const file = join(shop, ".claude", "skills", "write-a-database-migration", "SKILL.md");
    expect(readFileSync(file, "utf8")).toContain("dbtools:migrate");
    expect(snapshotTree(home.resolve(".claude/plugins"))).toEqual(before);
  });

  it("gives way to an owned Skill that overlaps too", async () => {
    const shop = migrationWorkflow();
    write(
      home.resolve(".claude/plugins/cache/acme-market/dbtools/1.2.0/skills/migrate/SKILL.md"),
      '---\nname: migrate\ndescription: "Run a database migration with dbtools."\n---\n',
    );
    const skill = write(join(shop, ".claude", "skills", "db-migrations", "SKILL.md"), ownedSkill);
    const opts = options();
    await analyze(opts);

    await suggest(opts);

    const [suggestion] = await review();
    expect(suggestion.target).toEqual({ kind: "skill", path: skill, name: "db-migrations" });
    expect(suggestion.companionOf).toBeNull();
  });
});

describe("a CLAUDE.md line that a Rule duplicates", () => {
  function pnpmCorrections(cwd: string) {
    session(cwd, "2026-05-10T09:00:00.000Z", "write a database migration for orders", "no, use pnpm not npm to run it");
    session(cwd, "2026-05-20T09:00:00.000Z", "update the release notes", "no, we use pnpm here");
    session(cwd, "2026-05-25T09:00:00.000Z", "fix the build", "no, pnpm please");
  }

  const claudeMd = "# Shop\n\nConventions:\n\n- Always run things with pnpm.\n- Keep functions small.\n";

  it("is the Rule's Target: accepting replaces that line instead of adding a second one, and restore undoes it", async () => {
    const shop = home.gitRepo("code/shop");
    pnpmCorrections(shop);
    const file = write(join(shop, "CLAUDE.md"), claudeMd);
    const opts = options();
    await analyze(opts);
    await suggest(opts);

    const rule = (await review()).find((s: any) => s.kind === "rule");

    expect(rule.target).toEqual({ kind: "rule", path: file, line: "- Always run things with pnpm." });
    expect(rule.diff).toContain("-- Always run things with pnpm.");
    expect(rule.diff).toContain("+- Use pnpm, never npm, to install packages and run scripts.");
    const [request] = opts.requests().filter((r) => r.includes("<correction-cluster"));
    expect(request).toContain("Always run things with pnpm.");

    const accepted = await runCli(home, ["accept", String(rule.id), "--json"], opts);

    expect(accepted.exitCode, accepted.stderr).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      "# Shop\n\nConventions:\n\n- Use pnpm, never npm, to install packages and run scripts.\n- Keep functions small.\n",
    );
    expect(accepted.json().backups).toEqual([{ path: file }]);

    expect((await runCli(home, ["restore", String(rule.id)], opts)).exitCode).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(claudeMd);
  });

  it("can live in the User scope CLAUDE.md", async () => {
    const shop = home.gitRepo("code/shop");
    pnpmCorrections(shop);
    const file = write(home.resolve(".claude/CLAUDE.md"), "- Use pnpm for everything.\n");
    const opts = options();
    await analyze(opts);
    await suggest(opts);

    const rule = (await review()).find((s: any) => s.kind === "rule");

    expect(rule.target).toEqual({ kind: "rule", path: file, line: "- Use pnpm for everything." });
  });
});
