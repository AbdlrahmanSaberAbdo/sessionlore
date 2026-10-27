import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDemo, type Demo } from "../../cli/src/demo.js";
import { Rail } from "../src/components/rail.js";
import { CorrectionsScreen } from "../src/screens/corrections.js";
import { PendingScreen, ReviewScreen, type ReviewActions } from "../src/screens/review.js";
import { SessionScreen } from "../src/screens/sessions.js";
import { WorkflowScreen, WorkflowsScreen } from "../src/screens/workflows.js";

/**
 * The UI smoke test on the demo dataset (`sessionlore demo`): the rail and each
 * screen render the data the demo's App gives the API, with meaningful content.
 */

let root: string;
let demo: Demo;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sessionlore-demo-ui-")));
  demo = await openDemo({ root, clock: { now: () => new Date("2026-06-01T12:00:00.000Z") } });
  // The demo runs a full scripted Analysis, which can take longer than the default hook timeout on a busy machine.
}, 30_000);

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
  it("The rail shows the Pending count and how many Sessions and Tasks were read", () => {
    const html = renderToStaticMarkup(
      <Rail section="/" pending={api(demo.app.reviewQueue()).suggestions.length} counts={api(demo.app.overview()).counts} />,
    );

    expect(html).toMatch(/Home<span class="count">3</);
    expect(html).toMatch(/Read from \d+ Sessions and \d+ Tasks/);
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

  it("Session viewer shows a Session with Task boundaries and Corrections", () => {
    const list = api(demo.app.browseWorkflows());
    const sessionIds = new Set(
      [...list.workflows, ...list.nearWorkflows].flatMap((w) => api(demo.app.browseWorkflow(w.id))!.tasks.map((t) => t.session)),
    );
    const corrected = [...sessionIds]
      .map((id) => api(demo.app.viewSession(id))!)
      .find((s) => s.messages.some((m) => m.role === "user" && m.text.startsWith("no, use pnpm")))!;

    const sessionHtml = renderToStaticMarkup(<SessionScreen session={corrected} />);

    expect(sessionHtml).toMatch(/class="message user correction"[^]*no, use pnpm not npm to run it/);
    expect(sessionHtml).toContain('class="task-boundary"');
    expect(sessionHtml).toContain("Write database migrations");
  });

  it("Corrections renders", () => {
    expect(renderToStaticMarkup(<CorrectionsScreen />)).toContain("Corrections");
  });

  it("Home lists Pending Suggestions, and the one with a Target shows its diff", () => {
    const queue = api(demo.app.reviewQueue());
    const targeted = queue.suggestions.find((s) => s.target)!;

    const queueHtml = renderToStaticMarkup(<PendingScreen queue={queue} />);
    const reviewHtml = renderToStaticMarkup(<ReviewScreen review={api(demo.app.reviewSuggestion(targeted.id))!} actions={noActions} />);

    for (const text of ["Write a database migration", "Update the release notes", "Use pnpm", "<h2>Skills</h2>", "<h2>Rules</h2>", "Updates "]) {
      expect(queueHtml).toContain(text);
    }
    expect(reviewHtml).toContain('<span class="del">-- Always run things with pnpm.');
    expect(reviewHtml).toContain('<span class="add">+- Use pnpm, never npm, to install packages and run scripts.');
    expect(reviewHtml).toContain("“no, use pnpm not npm to run it”");
  });
});
