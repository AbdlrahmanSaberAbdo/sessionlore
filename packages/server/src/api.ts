import {
  RenderError,
  SuggestionEditError,
  SuggestionStateError,
  type App,
  type BrowseFilter,
  type HarnessId,
  type ScopeChoice,
} from "@sessionlore/core";
import { Hono, type Context, type Next } from "hono";

/**
 * The JSON API. Each route calls one App method and returns its result as is;
 * the response shapes are the App's own types, which the UI imports too.
 */
export function apiRoutes(app: App): Hono {
  const api = new Hono();
  api.use("*", sameSiteChanges);
  api.get("/overview", (c) => c.json(app.overview()));
  api.get("/workflows", (c) => c.json(app.browseWorkflows(browseFilter(c))));
  api.get("/workflows/:id", (c) => {
    const id = c.req.param("id");
    const workflow = /^\d+$/.test(id) ? app.browseWorkflow(Number(id), browseFilter(c)) : null;
    return workflow ? c.json(workflow) : c.json({ error: `No Workflow has id ${id}.` }, 404);
  });
  api.get("/mind-map", (c) => c.json(app.mindMap(browseFilter(c))));
  api.get("/sessions", (c) => c.json(app.browseSessions(browseFilter(c))));
  api.get("/sessions/:id", (c) => {
    const session = app.viewSession(c.req.param("id"));
    return session ? c.json(session) : c.json({ error: `No Session has id ${c.req.param("id")}.` }, 404);
  });
  api.get("/suggestions", (c) => c.json(app.reviewQueue()));
  api.get("/suggestions/:id{[0-9]+}", (c) => {
    const review = app.reviewSuggestion(suggestionId(c));
    return review ? c.json(review) : c.json({ error: `No Suggestion has id ${c.req.param("id")}.` }, 404);
  });
  api.put("/suggestions/:id{[0-9]+}", async (c) => c.json(app.editSuggestion(suggestionId(c), await jsonBody(c))));
  api.put("/suggestions/:id{[0-9]+}/scope", async (c) => c.json(app.setScope(suggestionId(c), scopeChoice(await jsonBody(c))).suggestion));
  api.post("/suggestions/:id{[0-9]+}/accept", (c) => c.json(app.acceptSuggestion(suggestionId(c))));
  api.post("/suggestions/:id{[0-9]+}/reject", (c) => c.json(app.rejectSuggestion(suggestionId(c))));
  api.all("*", (c) => c.json({ error: `No API endpoint at ${c.req.path}` }, 404));
  api.onError((error, c) => {
    const message = error.message;
    if (error instanceof SuggestionStateError) return c.json({ error: message }, message.startsWith("No Suggestion") ? 404 : 409);
    if (error instanceof RenderError) return c.json({ error: message }, 409);
    if (error instanceof SuggestionEditError || error instanceof BadRequest) return c.json({ error: message }, 400);
    throw error;
  });
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

class BadRequest extends Error {}

/**
 * Changes may only come from the dashboard itself. A page on another site can
 * send this port a form-style POST, but not one with a JSON body (that needs a
 * CORS preflight, which is never granted), and its Origin gives it away.
 */
async function sameSiteChanges(c: Context, next: Next) {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const origin = c.req.header("origin");
  const contentType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "application/json" || (origin !== undefined && origin !== new URL(c.req.url).origin)) {
    return c.json({ error: "Changes are only accepted from the dashboard itself." }, 403);
  }
  return next();
}

function suggestionId(c: Context): number {
  return Number(c.req.param("id"));
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new BadRequest("The request body must be JSON.");
  }
}

/** `{ "kind": "user" }`, or `{ "kind": "project", "folder"?: "<a folder in the Project>" }`. */
function scopeChoice(body: unknown): ScopeChoice {
  const choice = body as { kind?: unknown; folder?: unknown } | null;
  if (choice?.kind === "user") return { kind: "user" };
  if (choice?.kind === "project" && (choice.folder === undefined || typeof choice.folder === "string")) {
    return choice.folder ? { kind: "project", folder: choice.folder } : { kind: "project" };
  }
  throw new BadRequest('A Scope is { "kind": "user" } or { "kind": "project", "folder": "<a folder in the Project>" }.');
}
