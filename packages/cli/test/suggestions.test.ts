import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const migrationSkill = {
  title: "Write a database migration",
  trigger: "Use when adding or changing a database table.",
  steps: ["Create a migration file in db/migrations.", "Run the migration locally.", "Add a rollback."],
};

/**
 * Splits every Session into one Task per User Message, names Clusters after
 * their topic, and writes a Skill Suggestion for any Workflow it is asked about.
 */
function modelProvider(skill: (request: string) => object = () => migrationSkill) {
  return scriptedModelProvider((request) => {
    if (request.includes("<workflow")) return skill(request);
    const messages = [...request.matchAll(/<message index=\\"(\d+)\\">\\n([\s\S]*?)\\n<\/message>/g)];
    if (messages.length === 0) return { name: request.includes("migration") ? "Write database migrations" : "Write release notes" };
    return {
      tasks: messages.map(([, index, text]) => ({
        title: text,
        messages: [{ index: Number(index), intent: "New Task" }],
      })),
    };
  });
}

function session(cwd: string, startedAt: string, ...requests: string[]) {
  return writeClaudeSession(home, {
    cwd,
    startedAt,
    turns: requests.flatMap((r) => [turn.user(r), turn.assistant("Done.")]),
  });
}

const now = fixedClock("2026-06-01T12:00:00.000Z");

function options(provider = modelProvider()): RunOptions & { requests(): string[] } {
  return {
    modelProvider: provider.modelProvider,
    embedder: topicEmbedder(["database migration", "release notes"]),
    clock: now,
    requests: provider.requests,
  };
}

async function analyze(opts: RunOptions) {
  expect((await runCli(home, ["scan"], opts)).exitCode).toBe(0);
  const analysis = await runCli(home, ["analyze", "--json", "--yes"], opts);
  expect(analysis.exitCode, analysis.stderr).toBe(0);
  expect(analysis.json().failed).toEqual([]);
}

async function suggest(opts: RunOptions) {
  const result = await runCli(home, ["suggest", "--json"], opts);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.json();
}

async function review(opts: RunOptions = {}) {
  const result = await runCli(home, ["review", "--json"], opts);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.json().suggestions;
}

/** Three migration Tasks across two Sessions in `shop` (a Workflow) and two release-notes Tasks (a near-Workflow). */
function workflowInOneProject() {
  const shop = home.gitRepo("code/shop");
  const first = session(shop, "2026-05-10T09:00:00.000Z", "write a database migration for orders", "update the release notes");
  const second = session(shop, "2026-05-20T09:00:00.000Z", "add a database migration for users", "release notes for 2.0");
  const third = session(shop, "2026-05-25T09:00:00.000Z", "database migration for the cart table");
  return { shop, sessions: [first, second, third] };
}

describe("suggest and review", () => {
  it("writes one Pending Skill Suggestion per Workflow with the strong model, and none for near-Workflows", async () => {
    const { shop, sessions } = workflowInOneProject();
    const opts = options();
    await analyze(opts);

    const result = await suggest(opts);

    expect(result.created).toHaveLength(1);
    const strongRequests = opts.requests().filter((r) => r.includes("<workflow"));
    expect(strongRequests).toHaveLength(1);
    expect(strongRequests[0]).toContain("write a database migration for orders");
    expect(result.usage.map((u: any) => u.model)).toContain("mock-strong");

    const suggestions = await review();
    expect(suggestions).toHaveLength(1);
    const [suggestion] = suggestions;
    expect(suggestion).toMatchObject({
      id: result.created[0],
      kind: "skill",
      state: "Pending",
      title: "Write a database migration",
      trigger: "Use when adding or changing a database table.",
      steps: migrationSkill.steps,
      workflow: { name: "Write database migrations" },
      scope: { kind: "project", project: { name: "shop", path: shop } },
    });
    expect(suggestion.evidence).toEqual([
      {
        task: { title: "write a database migration for orders", at: "2026-05-10T09:00:00.000Z" },
        session: { id: sessions[0]!.id, harness: "claude-code" },
        project: { name: "shop", path: shop },
      },
      {
        task: { title: "add a database migration for users", at: "2026-05-20T09:00:00.000Z" },
        session: { id: sessions[1]!.id, harness: "claude-code" },
        project: { name: "shop", path: shop },
      },
      {
        task: { title: "database migration for the cart table", at: "2026-05-25T09:00:00.000Z" },
        session: { id: sessions[2]!.id, harness: "claude-code" },
        project: { name: "shop", path: shop },
      },
    ]);
  });

  it("shows the strong model each Task's User Messages with their Intents, secrets redacted", async () => {
    const shop = home.gitRepo("code/shop");
    const apiKey = "sk-ant-api03-Zx9Qw2Lm7Rt4Vb8Nc1Kp5Hy3Jd6Fg0Ss";
    session(shop, "2026-05-10T09:00:00.000Z", `write a database migration for orders using key ${apiKey}`);
    session(shop, "2026-05-20T09:00:00.000Z", "add a database migration for users");
    session(shop, "2026-05-25T09:00:00.000Z", "database migration for the cart table");
    const opts = options();
    await analyze(opts);

    await suggest(opts);

    const [request] = opts.requests().filter((r) => r.includes("<workflow"));
    expect(request).toContain("New Task");
    expect(request).toContain("add a database migration for users");
    expect(request).toContain("[REDACTED:api-key]");
    expect(request).not.toContain(apiKey);
  });

  it("gives User scope to a Suggestion whose Evidence comes from several Projects", async () => {
    const shop = home.gitRepo("code/shop");
    const blog = home.gitRepo("code/blog");
    session(shop, "2026-05-10T09:00:00.000Z", "write a database migration for orders");
    session(blog, "2026-05-20T09:00:00.000Z", "add a database migration for posts");
    session(shop, "2026-05-25T09:00:00.000Z", "database migration for the cart table");
    const opts = options();
    await analyze(opts);

    await suggest(opts);

    const [suggestion] = await review();
    expect(suggestion.scope).toEqual({ kind: "user" });
    expect(suggestion.evidence.map((e: any) => e.project.name)).toEqual(["shop", "blog", "shop"]);
  });

  it("does not write a second Suggestion for a Workflow that already has a Pending one", async () => {
    workflowInOneProject();
    const opts = options();
    await analyze(opts);
    await suggest(opts);

    const again = await suggest(opts);

    expect(again.created).toEqual([]);
    expect(await review()).toHaveLength(1);
    expect(opts.requests().filter((r) => r.includes("<workflow"))).toHaveLength(1);
  });
});

describe("accept", () => {
  it("writes nothing to any skill directory until a Suggestion is Accepted", async () => {
    const { shop } = workflowInOneProject();
    const opts = options();
    await analyze(opts);
    await suggest(opts);
    await review();

    expect(existsSync(join(shop, ".claude", "skills"))).toBe(false);
    expect(existsSync(home.resolve(".claude/skills"))).toBe(false);
  });

  it("installs a Project scope Skill as a skill folder with a SKILL.md in the Project", async () => {
    const { shop } = workflowInOneProject();
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;

    const result = await runCli(home, ["accept", String(id), "--json"], opts);

    expect(result.exitCode, result.stderr).toBe(0);
    const file = join(shop, ".claude", "skills", "write-a-database-migration", "SKILL.md");
    expect(result.json()).toMatchObject({ suggestion: { id, state: "Accepted", acceptedAt: "2026-06-01T12:00:00.000Z" }, files: [{ path: file }] });
    expect(readFileSync(file, "utf8")).toBe(
      [
        "---",
        "name: write-a-database-migration",
        'description: "Write a database migration. Use when adding or changing a database table."',
        "---",
        "",
        "# Write a database migration",
        "",
        "Use when adding or changing a database table.",
        "",
        "## Steps",
        "",
        "1. Create a migration file in db/migrations.",
        "2. Run the migration locally.",
        "3. Add a rollback.",
        "",
      ].join("\n"),
    );
    expect(await review()).toEqual([]);
  });

  it("installs a User scope Skill in the home directory's skill folder", async () => {
    session(home.gitRepo("code/shop"), "2026-05-10T09:00:00.000Z", "write a database migration for orders");
    session(home.gitRepo("code/blog"), "2026-05-20T09:00:00.000Z", "add a database migration for posts", "database migration for tags");
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;

    const result = await runCli(home, ["accept", String(id)], opts);

    expect(result.exitCode, result.stderr).toBe(0);
    const file = home.resolve(".claude/skills/write-a-database-migration/SKILL.md");
    expect(result.stdout).toContain(file);
    expect(readFileSync(file, "utf8")).toMatch(/^---\nname: write-a-database-migration\n/);
  });

  it("refuses to overwrite an existing skill folder", async () => {
    const { shop } = workflowInOneProject();
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;
    const existing = join(shop, ".claude", "skills", "write-a-database-migration");
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, "SKILL.md"), "mine");

    const result = await runCli(home, ["accept", String(id)], opts);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("already exists");
    expect(readFileSync(join(existing, "SKILL.md"), "utf8")).toBe("mine");
    expect((await review()).map((s: any) => s.id)).toEqual([id]);
  });

  it("reports an unknown Suggestion id", async () => {
    const result = await runCli(home, ["accept", "42"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("No Suggestion has id 42");
  });
});

describe("reject", () => {
  it("marks a Suggestion Rejected, drops it from review, and a later suggest doesn't propose it again", async () => {
    const { shop } = workflowInOneProject();
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;

    const result = await runCli(home, ["reject", String(id), "--json"], opts);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json().suggestion).toMatchObject({ id, state: "Rejected", rejectedAt: "2026-06-01T12:00:00.000Z" });
    expect(await review()).toEqual([]);

    // The Workflow grows; it is still the same Workflow, so the Rejected Suggestion isn't proposed again.
    session(shop, "2026-05-28T09:00:00.000Z", "one more database migration for invoices");
    await analyze(opts);
    expect((await suggest(opts)).created).toEqual([]);
    expect(await review()).toEqual([]);
    expect(existsSync(join(shop, ".claude", "skills"))).toBe(false);
  });

  it("won't accept a Rejected Suggestion", async () => {
    workflowInOneProject();
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;
    await runCli(home, ["reject", String(id)], opts);

    const result = await runCli(home, ["accept", String(id)], opts);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("already Rejected");
  });
});

describe("edit", () => {
  it("saves what the person changes in their editor, and accept writes the edited Suggestion", async () => {
    const { shop } = workflowInOneProject();
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;

    const edited = await runCli(home, ["edit", String(id)], {
      ...opts,
      editor: (text) => {
        const form = JSON.parse(text);
        expect(form).toEqual({ title: migrationSkill.title, trigger: migrationSkill.trigger, steps: migrationSkill.steps });
        return JSON.stringify({ ...form, title: "Add a migration", steps: ["Create db/migrations/<n>.sql.", "Run it."] });
      },
    });

    expect(edited.exitCode, edited.stderr).toBe(0);
    const [suggestion] = await review();
    expect(suggestion).toMatchObject({ id, title: "Add a migration", steps: ["Create db/migrations/<n>.sql.", "Run it."] });
    expect((await runCli(home, ["accept", String(id)], opts)).exitCode).toBe(0);
    const skill = readFileSync(join(shop, ".claude", "skills", "add-a-migration", "SKILL.md"), "utf8");
    expect(skill).toContain("# Add a migration");
    expect(skill).toContain("1. Create db/migrations/<n>.sql.\n2. Run it.\n");
    expect(skill).not.toContain("Add a rollback");
  });

  it.each(["accept", "reject"])("won't edit a Suggestion after %s", async (action) => {
    workflowInOneProject();
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;
    expect((await runCli(home, [action, String(id)], opts)).exitCode).toBe(0);

    const result = await runCli(home, ["edit", String(id)], opts);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/already (Accepted|Rejected); only Pending Suggestions can be edited/);
  });

  it("keeps the Suggestion unchanged when the edit isn't valid", async () => {
    workflowInOneProject();
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;

    const broken = await runCli(home, ["edit", String(id)], { ...opts, editor: (text) => text.replace("{", "") });
    const emptied = await runCli(home, ["edit", String(id)], {
      ...opts,
      editor: (text) => JSON.stringify({ ...JSON.parse(text), steps: [] }),
    });

    expect(broken.exitCode).not.toBe(0);
    expect(broken.stderr).toContain("not valid JSON");
    expect(emptied.exitCode).not.toBe(0);
    expect(emptied.stderr).toContain('"steps" must be a non-empty list');
    expect((await review())[0]).toMatchObject({ title: migrationSkill.title, steps: migrationSkill.steps });
  });
});

describe("scope", () => {
  it("overriding Project scope with User scope makes accept install in the home directory", async () => {
    const { shop } = workflowInOneProject();
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;

    const result = await runCli(home, ["scope", String(id), "user", "--json"], opts);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json().suggestion.scope).toEqual({ kind: "user" });
    expect((await review())[0].scope).toEqual({ kind: "user" });
    expect((await runCli(home, ["accept", String(id)], opts)).exitCode).toBe(0);
    expect(existsSync(home.resolve(".claude/skills/write-a-database-migration/SKILL.md"))).toBe(true);
    expect(existsSync(join(shop, ".claude", "skills"))).toBe(false);
  });

  it("sets Project scope to the Project of a given folder", async () => {
    const shop = home.gitRepo("code/shop");
    const blog = home.gitRepo("code/blog");
    session(shop, "2026-05-10T09:00:00.000Z", "write a database migration for orders");
    session(blog, "2026-05-20T09:00:00.000Z", "add a database migration for posts", "database migration for tags");
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;

    const result = await runCli(home, ["scope", String(id), "project", join(blog, "src")], opts);

    expect(result.exitCode, result.stderr).toBe(0);
    expect((await review())[0].scope).toEqual({ kind: "project", project: { name: "blog", path: blog } });
    expect((await runCli(home, ["accept", String(id)], opts)).exitCode).toBe(0);
    expect(existsSync(join(blog, ".claude", "skills", "write-a-database-migration", "SKILL.md"))).toBe(true);
  });

  it("needs a folder for Project scope when the Evidence spans several Projects", async () => {
    session(home.gitRepo("code/shop"), "2026-05-10T09:00:00.000Z", "write a database migration for orders");
    session(home.gitRepo("code/blog"), "2026-05-20T09:00:00.000Z", "add a database migration for posts", "database migration for tags");
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;

    const result = await runCli(home, ["scope", String(id), "project"], opts);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("several Projects");
  });

  it("won't change the Scope of an Accepted Suggestion", async () => {
    workflowInOneProject();
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;
    await runCli(home, ["accept", String(id)], opts);

    const result = await runCli(home, ["scope", String(id), "user"], opts);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("only Pending Suggestions");
  });
});
