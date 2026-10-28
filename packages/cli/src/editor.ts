import { spawn } from "node:child_process";
import type { Env } from "@habitlore/core";

/**
 * Opens a file in the person's editor ($VISUAL, then $EDITOR, then vi) and
 * resolves once they close it. The variable may carry arguments, as in
 * `code --wait`, so it runs through the shell with the path as its argument.
 */
export function openInEditor(path: string, env: Env): Promise<void> {
  const editor = env.VISUAL?.trim() || env.EDITOR?.trim() || "vi";
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", `${editor} "$1"`, "habitlore-edit", path], { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`The editor (${editor}) exited with code ${code ?? "unknown"}; nothing was saved.`)),
    );
  });
}
