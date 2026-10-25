import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@sessionlore/fixtures";
import { openApi, type Api } from "./support/api.js";
import { topicEmbedder } from "./support/embedder.js";
import { snapshotTree } from "./support/files.js";
import { fixedClock, runCli, type RunOptions } from "./support/harness.js";
import { scriptedModelProvider } from "./support/model-provider.js";

let home: FixtureHome;
let api: Api | undefined;
const others: FixtureHome[] = [];

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  api?.close();
  api = undefined;
  home.remove();
  others.splice(0).forEach((h) => h.remove());
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
const provider = scriptedModelProvider((request) => {
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

const options: RunOptions = {
  modelProvider: provider.modelProvider,
  embedder: topicEmbedder(["database migration", "pnpm", "release notes"]),
  clock: fixedClock("2026-06-01T12:00:00.000Z"),
};

function session(at: FixtureHome, repo: string, startedAt: string, ...messages: string[]) {
  return writeClaudeSession(at, {
    cwd: at.gitRepo(repo),
    startedAt,
    turns: messages.flatMap((m) => [turn.user(m), turn.assistant("Done.")]),
  });
}

/** In `shop`: three database-migration Tasks (a Workflow), each with a pnpm Correction (a Correction Cluster). */
function migrationsWithPnpmCorrections(at: FixtureHome = home) {
  return [
    session(at, "code/shop", "2026-05-10T09:00:00.000Z", "fix the footer", "write a database migration for orders", "no, use pnpm not npm to run it"),
    session(at, "code/shop", "2026-05-20T09:00:00.000Z", "add a database migration for users", "no, we use pnpm here"),
    session(at, "code/shop", "2026-05-25T09:00:00.000Z", "database migration for the cart table", "no, pnpm please"),
  ];
}

async function cli(at: FixtureHome, ...args: string[]) {
  const result = await runCli(at, args, options);
  expect(result.exitCode, result.stderr).toBe(0);
  return result;
}

/** Scans, analyzes and suggests; returns the ids of the Skill and the Rule written. */
async function suggestAll(at: FixtureHome = home) {
  await cli(at, "scan");
  expect((await cli(at, "analyze", "--json", "--yes")).json().failed).toEqual([]);
  await cli(at, "suggest", "--json");
  const all = (await cli(at, "review", "--json")).json().suggestions as any[];
  return { skill: all.find((s) => s.kind === "skill").id as number, rule: all.find((s) => s.kind === "rule").id as number };
}

function server(): Api {
  api ??= openApi(home, options);
  return api;
}

async function get(path: string) {
  const response = await server().get(path);
  expect(response.status, response.text).toBe(200);
  return response.json();
}

async function send(method: "POST" | "PUT", path: string, body?: unknown) {
  const response = await server().send(method, path, body);
  expect(response.status, response.text).toBe(200);
  return response.json();
}

function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe("review queue API", () => {
  it("lists Pending Suggestions with their kind, Scope and Evidence count", async () => {
    migrationsWithPnpmCorrections();
    const { skill, rule } = await suggestAll();
    const shop = home.gitRepo("code/shop");

    const queue = await get("/api/suggestions");

    expect(queue.suggestions).toEqual([
      {
        id: skill,
        kind: "skill",
        title: "Write a database migration",
        scope: { kind: "project", project: { name: "shop", path: shop } },
        evidence: 3,
        target: null,
        createdAt: "2026-06-01T12:00:00.000Z",
      },
      {
        id: rule,
        kind: "rule",
        title: "Use pnpm",
        scope: { kind: "project", project: { name: "shop", path: shop } },
        evidence: 3,
        target: null,
        createdAt: "2026-06-01T12:00:00.000Z",
      },
    ]);
  });

  it("drops Accepted and Rejected Suggestions from the queue", async () => {
    migrationsWithPnpmCorrections();
    const { skill, rule } = await suggestAll();

    const accepted = await send("POST", `/api/suggestions/${skill}/accept`);
    const rejected = await send("POST", `/api/suggestions/${rule}/reject`);

    expect(accepted.suggestion.state).toBe("Accepted");
    expect(rejected.state).toBe("Rejected");
    expect((await get("/api/suggestions")).suggestions).toEqual([]);
    expect((await cli(home, "review", "--json")).json().suggestions).toEqual([]);
  });
});

describe("one Suggestion in review", () => {
  it("shows the content accepting will write, its editable form, and its Evidence linked to the Session viewer", async () => {
    const sessions = migrationsWithPnpmCorrections();
    const { skill } = await suggestAll();
    const file = join(home.gitRepo("code/shop"), ".claude", "skills", "write-a-database-migration", "SKILL.md");

    const review = await get(`/api/suggestions/${skill}`);

    expect(review.suggestion).toMatchObject({ id: skill, kind: "skill", state: "Pending", steps: migrationSkill.steps });
    expect(review.form).toEqual(migrationSkill);
    expect(review.changes).toHaveLength(1);
    expect(review.changes[0]).toMatchObject({ path: file, before: null });
    expect(review.changes[0].after).toContain("1. Create a migration file in db/migrations.\n");
    expect(review.changesError).toBeNull();
    // The first Session's migration Task is its second Task.
    expect(review.evidence.map((e: any) => [e.task.title, e.link])).toEqual([
      ["write a database migration for orders", `/sessions/${sessions[0]!.id}#task-1`],
      ["add a database migration for users", `/sessions/${sessions[1]!.id}#task-0`],
      ["database migration for the cart table", `/sessions/${sessions[2]!.id}#task-0`],
    ]);
  });

  it("shows a Rule's Evidence as its Corrections", async () => {
    migrationsWithPnpmCorrections();
    const { rule } = await suggestAll();

    const review = await get(`/api/suggestions/${rule}`);

    expect(review.form).toEqual(pnpmRule);
    expect(review.evidence.map((e: any) => e.correction.text)).toEqual(["no, use pnpm not npm to run it", "no, we use pnpm here", "no, pnpm please"]);
  });

  it("shows a diff against the Target for a Suggestion that updates an existing file", async () => {
    migrationsWithPnpmCorrections();
    const claudeMd = write(join(home.gitRepo("code/shop"), "CLAUDE.md"), "# Shop\n\n- Always run things with pnpm.\n");
    const { rule } = await suggestAll();

    const review = await get(`/api/suggestions/${rule}`);

    expect(review.suggestion.target).toEqual({ kind: "rule", path: claudeMd, line: "- Always run things with pnpm." });
    expect(review.changes[0].diff).toContain("-- Always run things with pnpm.");
    expect(review.changes[0].diff).toContain("+- Use pnpm, never npm, to install packages and run scripts.");
  });

  it("answers 404 for a Suggestion that does not exist", async () => {
    const response = await server().get("/api/suggestions/999");

    expect(response.status).toBe(404);
    expect(response.json().error).toContain("999");
  });
});

describe("review actions", () => {
  it("edit, Scope change and accept in the browser write the same files and states as the CLI commands", async () => {
    const edited = { ...migrationSkill, title: "Add a migration", steps: ["Create db/migrations/<n>.sql.", "Run it."] };
    // The browser, in this home.
    migrationsWithPnpmCorrections();
    const { skill } = await suggestAll();
    await send("PUT", `/api/suggestions/${skill}`, edited);
    const scoped = await send("PUT", `/api/suggestions/${skill}/scope`, { kind: "user" });
    const accepted = await send("POST", `/api/suggestions/${skill}/accept`);
    // The CLI, in another home with the same Sessions.
    const other = FixtureHome.create();
    others.push(other);
    migrationsWithPnpmCorrections(other);
    const viaCli = await suggestAll(other);
    await runCli(other, ["edit", String(viaCli.skill)], { ...options, editor: () => JSON.stringify(edited) });
    await cli(other, "scope", String(viaCli.skill), "user");
    const acceptedViaCli = (await cli(other, "accept", String(viaCli.skill), "--json")).json();

    expect(scoped.scope).toEqual({ kind: "user" });
    const file = home.resolve(".claude/skills/add-a-migration/SKILL.md");
    expect(accepted.files.map((f: any) => f.path)).toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe(readFileSync(other.resolve(".claude/skills/add-a-migration/SKILL.md"), "utf8"));
    const comparable = (s: any) => ({ ...s, evidence: s.evidence.length, id: undefined, installedFiles: s.installedFiles.length });
    expect(comparable(accepted.suggestion)).toEqual(comparable(acceptedViaCli.suggestion));
  });

  it("sets Project scope by a folder in the Project", async () => {
    migrationsWithPnpmCorrections();
    session(home, "code/blog", "2026-05-26T09:00:00.000Z", "write the blog post");
    const { skill } = await suggestAll();
    const blog = home.gitRepo("code/blog");

    const scoped = await send("PUT", `/api/suggestions/${skill}/scope`, { kind: "project", folder: blog });

    expect(scoped.scope).toEqual({ kind: "project", project: { name: "blog", path: blog } });
    expect((await get(`/api/suggestions/${skill}`)).changes[0].path).toBe(join(blog, ".claude", "skills", "write-a-database-migration", "SKILL.md"));
  });

  it("offers the known Projects to scope a Suggestion to", async () => {
    migrationsWithPnpmCorrections();
    session(home, "code/blog", "2026-05-26T09:00:00.000Z", "write the blog post");
    const { skill } = await suggestAll();

    const review = await get(`/api/suggestions/${skill}`);

    expect(review.projects.map((p: any) => p.name)).toEqual(["blog", "shop"]);
  });

  it("refuses an invalid edit and keeps the Suggestion unchanged", async () => {
    migrationsWithPnpmCorrections();
    const { skill } = await suggestAll();

    const response = await server().send("PUT", `/api/suggestions/${skill}`, { ...migrationSkill, steps: [] });

    expect(response.status).toBe(400);
    expect(response.json().error).toContain('"steps" must be a non-empty list');
    expect((await get(`/api/suggestions/${skill}`)).form).toEqual(migrationSkill);
  });

  it("refuses to act on a Suggestion that is no longer Pending, writing nothing", async () => {
    migrationsWithPnpmCorrections();
    const { skill } = await suggestAll();
    await send("POST", `/api/suggestions/${skill}/reject`);
    const before = snapshotTree(home.path);

    const accept = await server().send("POST", `/api/suggestions/${skill}/accept`);
    const edit = await server().send("PUT", `/api/suggestions/${skill}`, migrationSkill);

    expect(accept.status).toBe(409);
    expect(accept.json().error).toContain("already Rejected");
    expect(edit.status).toBe(409);
    expect(snapshotTree(home.path)).toEqual(before);
    // It can still be looked at, without a preview.
    const review = await get(`/api/suggestions/${skill}`);
    expect(review).toMatchObject({ suggestion: { state: "Rejected" }, form: null, changes: null });
  });

  it("answers 404 for actions on a Suggestion that does not exist", async () => {
    const response = await server().send("POST", "/api/suggestions/999/accept");

    expect(response.status).toBe(404);
  });

  it("refuses changes sent from another site, so a web page can't accept Suggestions behind the person's back", async () => {
    migrationsWithPnpmCorrections();
    const { skill } = await suggestAll();

    const crossSite = await server().send("POST", `/api/suggestions/${skill}/accept`, undefined, { origin: "https://evil.example" });
    const formPost = await server().send("POST", `/api/suggestions/${skill}/accept`, undefined, { "content-type": "text/plain" });

    expect(crossSite.status).toBe(403);
    expect(formPost.status).toBe(403);
    expect((await get("/api/suggestions")).suggestions).toHaveLength(2);
  });
});
