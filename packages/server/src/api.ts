import type { App, BrowseFilter, HarnessId } from "@sessionlore/core";
import { Hono, type Context } from "hono";

/**
 * The JSON API. Each route calls one App method and returns its result as is;
 * the response shapes are the App's own types, which the UI imports too.
 */
export function apiRoutes(app: App): Hono {
  const api = new Hono();
  api.get("/overview", (c) => c.json(app.overview()));
  api.get("/workflows", (c) => c.json(app.browseWorkflows(browseFilter(c))));
  api.get("/workflows/:id", (c) => {
    const id = c.req.param("id");
    const workflow = /^\d+$/.test(id) ? app.browseWorkflow(Number(id), browseFilter(c)) : null;
    return workflow ? c.json(workflow) : c.json({ error: `No Workflow has id ${id}.` }, 404);
  });
  api.get("/mind-map", (c) => c.json(app.mindMap(browseFilter(c))));
  api.get("/sessions",(c) => c.json(app.browseSessions(browseFilter(c))));
  api.get("/sessions/:id", (c) => {
    const session = app.viewSession(c.req.param("id"));
    return session ? c.json(session) : c.json({ error: `No Session has id ${c.req.param("id")}.` }, 404);
  });
  api.all("*", (c) => c.json({ error: `No API endpoint at ${c.req.path}` }, 404));
  return api;
}

/** `?project=<root>&harness=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD`; empty values are ignored. */
function browseFilter(c: Context): BrowseFilter {
  const value = (name: string) => c.req.query(name) || undefined;
  return {
    project: value("project"),
    harness: value("harness") as HarnessId | undefined,
    from: value("from"),
    to: value("to"),
  };
}
