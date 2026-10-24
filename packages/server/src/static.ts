import { readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { Context } from "hono";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Serves the built UI. Paths that are not a file get index.html, so the UI's
 * own routes (such as /workflows) load the app. Nothing outside `uiDir` is served.
 */
export function serveUi(uiDir: string | undefined) {
  const root = uiDir && resolve(uiDir);
  return async (c: Context) => {
    if (!root) return notBuilt(c);
    const file = await existingFile(root, decodeURIComponent(c.req.path));
    const target = file ?? (await existingFile(root, "/index.html"));
    if (!target) return notBuilt(c);
    const body = await readFile(target);
    const type = contentTypes[extname(target)] ?? "application/octet-stream";
    // Hashed assets never change; index.html must always be fetched fresh to pick up new ones.
    const cache = target.endsWith(`${sep}index.html`) ? "no-cache" : "public, max-age=31536000, immutable";
    return c.body(body, 200, { "content-type": type, "cache-control": cache });
  };
}

async function existingFile(root: string, urlPath: string): Promise<string | null> {
  const path = resolve(join(root, urlPath));
  const inside = relative(root, path);
  if (inside.startsWith("..") || inside === "") return null;
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

function notBuilt(c: Context) {
  return c.text("The sessionlore dashboard UI is not built. Run `corepack pnpm build` and start `sessionlore serve` again.\n", 503);
}
