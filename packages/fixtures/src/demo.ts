import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { turn, writeClaudeSession, type ClaudeTurn } from "./claude-code.js";
import { bubble, writeCursorDatabase, type CursorBubble } from "./cursor.js";
import type { FixtureHome } from "./home.js";

/**
 * The demo dataset (`sessionlore demo`): made-up Claude Code and Cursor
 * Sessions, written with the same builders the tests use, that contain
 * repeated Workflows, a near-Workflow, a Correction Cluster and a near one.
 *
 * `demoTopics` is the script the demo's Analysis follows instead of a Model
 * Provider: what each topic's Cluster is called and the Skill or Rule written
 * for it. Every text that mentions a topic's keyword belongs to that topic.
 */

export interface DemoTopic {
  /** Lower-case text that marks a Task or Correction as belonging to this topic. */
  keyword: string;
  /** The Cluster's name. */
  name: string;
  skill?: { title: string; trigger: string; steps: string[] };
  rule?: { title: string; rule: string };
}

/** Task topics first, then Correction topics: a Task that mentions both belongs to its Task topic. */
export const demoTopics: readonly DemoTopic[] = [
  {
    keyword: "database migration",
    name: "Write database migrations",
    skill: {
      title: "Write a database migration",
      trigger: "Use when adding or changing a database table in the shop.",
      steps: [
        "Create a timestamped migration file in db/migrations.",
        "Write the change and its rollback in one transaction.",
        "Run `pnpm db:migrate` locally, then `pnpm db:rollback` to check the rollback.",
        "Add or update the model tests for the changed table.",
      ],
    },
  },
  {
    keyword: "release notes",
    name: "Update the release notes",
    skill: {
      title: "Update the release notes",
      trigger: "Use when a new version of the blog engine is about to be tagged.",
      steps: [
        "List the merged pull requests since the previous tag.",
        "Group them under Added, Changed and Fixed.",
        "Put the new release at the top of RELEASES.md with today's date.",
      ],
    },
  },
  { keyword: "bump dependencies", name: "Bump dependencies" },
  {
    keyword: "pnpm",
    name: "Use pnpm, not npm",
    rule: { title: "Use pnpm", rule: "Use pnpm, never npm, to install packages and run scripts." },
  },
  { keyword: "newest release", name: "Newest release goes first" },
];

/** The topic `text` belongs to, if any. */
export function demoTopic(text: string): DemoTopic | undefined {
  const lower = text.toLowerCase();
  return demoTopics.find((t) => lower.includes(t.keyword));
}

/** The shop's CLAUDE.md already says to use pnpm, so the demo's Rule updates that line (its Target). */
export const DEMO_CLAUDE_MD = "# Shop\n\nConventions:\n\n- Always run things with pnpm.\n- Keep functions small.\n";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Writes the demo's Harness data into `home`, dated in the weeks before `now`. */
export function writeDemoHarnessData(home: FixtureHome, now: Date): void {
  const shop = home.gitRepo("code/shop");
  const blog = home.gitRepo("code/blog");
  const api = home.gitRepo("code/api");
  writeFileSync(join(shop, "CLAUDE.md"), DEMO_CLAUDE_MD);

  const daysAgo = (days: number) => {
    const at = new Date(now.getTime() - days * DAY_MS);
    at.setUTCHours(9, 0, 0, 0);
    return at.toISOString();
  };
  const claude = (cwd: string, days: number, turns: ClaudeTurn[]) =>
    writeClaudeSession(home, { cwd, startedAt: daysAgo(days), turns, stepSeconds: 45 });

  claude(shop, 40, [
    turn.user("write a database migration for the orders table"),
    turn.tool("Bash", { command: "npm run db:migrate" }, "migrated 1 file"),
    turn.assistant("Added db/migrations/20260420_orders.sql and ran it."),
    turn.user("no, use pnpm not npm to run it"),
    turn.tool("Bash", { command: "pnpm db:migrate" }, "migrated 1 file"),
    turn.assistant("Re-ran it with pnpm."),
    turn.user("also add an index on created_at"),
    turn.assistant("Added the index in the same migration."),
  ]);
  claude(shop, 30, [
    turn.user("add a database migration for the users table"),
    turn.tool("Write", { file_path: "db/migrations/20260501_users.sql" }, "written"),
    turn.assistant("Wrote the migration. Run it with `npm run db:migrate`."),
    turn.user("no, we use pnpm here"),
    turn.assistant("Right, `pnpm db:migrate`."),
  ]);
  claude(blog, 25, [
    turn.user("update the release notes for v1.4"),
    turn.tool("Bash", { command: "git log v1.3..HEAD --oneline" }, "12 commits"),
    turn.assistant("Added a v1.4 section at the end of RELEASES.md."),
    turn.user("no, the newest release goes at the top"),
    turn.assistant("Moved it to the top."),
  ]);
  claude(blog, 12, [
    turn.user("update the release notes for v1.5"),
    turn.assistant("Added v1.5 at the top of RELEASES.md."),
    turn.user("fix the typo in the footer"),
    turn.tool("Edit", { file_path: "theme/footer.html" }, "edited"),
    turn.assistant("Fixed “copywrite” to “copyright”."),
  ]);
  claude(shop, 8, [
    turn.user("bump dependencies and check the build"),
    turn.tool("Bash", { command: "npm update" }, "updated 14 packages"),
    turn.assistant("Updated 14 packages; the build passes."),
    turn.user("no, pnpm please"),
    turn.assistant("Redid it with `pnpm update`."),
  ]);
  claude(blog, 3, [
    turn.user("update the release notes for v1.6"),
    turn.assistant("Added v1.6 below v1.5."),
    turn.user("no, newest release first, like always"),
    turn.assistant("Moved v1.6 to the top."),
  ]);

  const cursor = (folder: string, days: number, bubbles: CursorBubble[]) => ({ folder, createdAt: daysAgo(days), bubbles, stepSeconds: 40 });
  writeCursorDatabase(home, [
    cursor(shop, 20, [
      bubble.user("database migration for the cart table"),
      bubble.tool("run_terminal_command_v2"),
      bubble.assistant("Created the cart migration and ran it with npm."),
      bubble.user("no, pnpm please, not npm"),
      bubble.assistant("Re-ran it with pnpm."),
    ]),
    cursor(shop, 15, [
      bubble.user("write a database migration for the payments table", { wrapped: true }),
      bubble.tool("edit_file"),
      bubble.assistant("Added the payments migration with a rollback."),
    ]),
    cursor(api, 5, [
      bubble.user("bump dependencies in the api"),
      bubble.tool("run_terminal_command_v2"),
      bubble.assistant("Bumped 6 packages; tests pass."),
    ]),
  ]);
}
