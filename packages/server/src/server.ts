import type { App } from "@habitlore/core";
import { Hono } from "hono";
import { apiRoutes } from "./api.js";
import { serveUi } from "./static.js";

/**
 * The dashboard's HTTP server: a JSON API under `/api` over the application
 * interface, and the built UI for every other path. It holds no domain logic.
 */

export interface ServerOptions {
  app: App;
  /** Folder holding the built UI (index.html and its assets). Without it, only the API is served. */
  uiDir?: string;
}

/** A fetch-style handler, so tests (Seam 2) can call it in-process without opening a port. */
export interface DashboardServer {
  fetch(request: Request): Promise<Response>;
}

export function createServer({ app, uiDir }: ServerOptions): DashboardServer {
  const server = new Hono();
  server.route("/api", apiRoutes(app));
  server.get("*", serveUi(uiDir));
  server.onError((error, c) => c.json({ error: error instanceof Error ? error.message : String(error) }, 500));
  return { fetch: async (request) => server.fetch(request) };
}
