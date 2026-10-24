import type { App } from "@sessionlore/core";
import { Hono } from "hono";

/**
 * The JSON API. Each route calls one App method and returns its result as is;
 * the response shapes are the App's own types, which the UI imports too.
 */
export function apiRoutes(app: App): Hono {
  const api = new Hono();
  api.get("/overview", (c) => c.json(app.overview()));
  api.all("*", (c) => c.json({ error: `No API endpoint at ${c.req.path}` }, 404));
  return api;
}
