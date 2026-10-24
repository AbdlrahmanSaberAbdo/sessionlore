import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every file under `dir` with its content hash and modification time. */
export function snapshotTree(dir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const info = statSync(path);
    snapshot[path] = entry.isFile()
      ? `${createHash("sha256").update(readFileSync(path)).digest("hex")}:${info.mtimeMs}`
      : `dir:${info.mtimeMs}`;
  }
  return snapshot;
}
