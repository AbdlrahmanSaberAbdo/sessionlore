import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDemo, type Demo } from "../../cli/src/demo.js";
import { MindMapScreen } from "../src/screens/mind-map.js";
import { OverviewScreen } from "../src/screens/overview.js";
import { ReviewQueueScreen, ReviewScreen, type ReviewActions } from "../src/screens/review.js";
import { SessionScreen, SessionsScreen } from "../src/screens/sessions.js";
import { WorkflowScreen, WorkflowsScreen } from "../src/screens/workflows.js";

/**
 * The UI smoke test on the demo dataset (`sessionlore demo`): each of the five
 * screens renders the data the demo's App gives the API, with meaningful content.
 */

let root: string;
let demo: Demo;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sessionlore-demo-ui-")));
  demo = await openDemo({ root, clock: { now: () => new Date("2026-06-01T12:00:00.000Z") } });
});

afterAll(() => {
  demo.close();
  rmSync(root, { recursive: true, force: true });
});

/** What the API would send: the App's result, as JSON. */
function api<T>(result: T): T {
  return JSON.parse(JSON.stringify(result)) as T;
}

const noActions: ReviewActions = { save: async () => {}, setScope: async () => {}, accept: async () => {}, reject: async () => {} };

describe("the dashboard on the demo dataset", () => {
  it("Overview shows the counts, top Workflows and Corrections over time", () => {
    const html = renderToStaticMarkup(<OverviewScreen overview={api(demo.app.overview())} />);

    expect(html).toContain("Write database migrations");
    expect(html).toContain("Update the release notes");
    expect(html).toMatch(/<svg[^>]*aria-label="Corrections per week"/);
  });

  it("Workflows lists Workflows and near-Workflows, and a Workflow shows its Tasks", () => {
    const list = api(demo.app.browseWorkflows());
    const migrations = list.workflows.find((w) => w.name === "Write database migrations")!;

    const listHtml = renderToStaticMarkup(<WorkflowsScreen list={list} filter={{}} />);
    const detailHtml = renderToStaticMarkup(<WorkflowScreen workflow={api(demo.app.browseWorkflow(migrations.id))!} filter={{}} />);

    expect(listHtml).toContain("Cursor");
    expect(listHtml).toContain("Bump dependencies");
    expect(listHtml).toContain("needs 1 more Task");
    expect(detailHtml).toContain("database migration for the cart table");
    expect(detailHtml).toContain("Write a database migration");
  });

  it("Session viewer lists Sessions and shows one with Task boundaries and Corrections", () => {
    const sessions = api(demo.app.browseSessions());
    const corrected = sessions.sessions
      .map((s) => api(demo.app.viewSession(s.id))!)
      .find((s) => s.messages.some((m) => m.role === "user" && m.text.startsWith("no, use pnpm")))!;

    const listHtml = renderToStaticMarkup(<SessionsScreen list={sessions} filter={{}} />);
    const sessionHtml = renderToStaticMarkup(<SessionScreen session={corrected} />);

    expect(listHtml).toContain("shop");
    expect(listHtml).toContain("blog");
    expect(sessionHtml).toMatch(/class="message user correction"[^]*no, use pnpm not npm to run it/);
    expect(sessionHtml).toContain('class="task-boundary"');
    expect(sessionHtml).toContain("Write database migrations");
  });

  it("Mind map draws Projects, Workflows, Tasks, Sessions and Suggestions coloured by Harness", () => {
    const html = renderToStaticMarkup(<MindMapScreen map={api(demo.app.mindMap())} filter={{}} />);

    expect(html).toContain("shop");
    expect(html).toContain("Write database migrations");
    expect(html).toMatch(/class="mind-node task harness-cursor"/);
    expect(html).toMatch(/class="mind-node session harness-claude-code"/);
    expect(html).toContain("Write a database migration");
  });

  it("Review lists Pending Suggestions, and the one with a Target shows its diff", () => {
    const queue = api(demo.app.reviewQueue());
    const targeted = queue.suggestions.find((s) => s.target)!;

    const queueHtml = renderToStaticMarkup(<ReviewQueueScreen queue={queue} />);
    const reviewHtml = renderToStaticMarkup(<ReviewScreen review={api(demo.app.reviewSuggestion(targeted.id))!} actions={noActions} />);

    for (const text of ["Write a database migration", "Update the release notes", "Use pnpm", "Skill", "Rule", "Updates "]) {
      expect(queueHtml).toContain(text);
    }
    expect(reviewHtml).toContain('<span class="del">-- Always run things with pnpm.');
    expect(reviewHtml).toContain('<span class="add">+- Use pnpm, never npm, to install packages and run scripts.');
    expect(reviewHtml).toContain("“no, use pnpm not npm to run it”");
  });
});
