import type { FixtureHome } from "@sessionlore/fixtures";
import { createServer } from "@sessionlore/server";
import { openApp } from "../../src/index.js";
import { fixedClock, type RunOptions } from "./harness.js";

/**
 * Seam 2: the dashboard's HTTP API, called in-process without opening a port.
 * The server is wired exactly as `sessionlore serve` wires it, against the same
 * fixture home directories Seam 1 uses, so a test can build data through the
 * CLI and read it back through the API.
 */

export interface ApiResponse {
  status: number;
  contentType: string | null;
  text: string;
  json<T = any>(): T;
}

export interface Api {
  get(path: string): Promise<ApiResponse>;
  /** Sends `body` as JSON, the way the UI does; `headers` add to or override the defaults. */
  send(method: "POST" | "PUT", path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse>;
  close(): void;
}

export interface ApiOptions extends Pick<RunOptions, "env" | "clock" | "modelProvider" | "embedder"> {
  /** Folder of built UI files the server serves; omitted means the UI is not built. */
  uiDir?: string;
}

export function openApi(home: FixtureHome, options: ApiOptions = {}): Api {
  const app = openApp({
    homeDir: home.path,
    env: { HOME: home.path, ...options.env },
    clock: options.clock ?? fixedClock("2026-06-01T12:00:00.000Z"),
    modelProvider: options.modelProvider,
    embedder: options.embedder,
  });
  const server = createServer({ app, uiDir: options.uiDir });
  const call = async (request: Request): Promise<ApiResponse> => {
    const response = await server.fetch(request);
    const text = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      text,
      json: () => JSON.parse(text),
    };
  };
  return {
    get: (path) => call(new Request(new URL(path, "http://localhost"))),
    send: (method, path, body, headers) =>
      call(
        new Request(new URL(path, "http://localhost"), {
          method,
          headers: { "content-type": "application/json", origin: "http://localhost", ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      ),
    close: () => app.close(),
  };
}
