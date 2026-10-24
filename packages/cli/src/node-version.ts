/**
 * Kept free of imports so the bin entry can run it on old Node versions,
 * before anything that needs `node:sqlite` is loaded.
 */
export const REQUIRED_NODE_VERSION = "22.13.0";

/** A message explaining why `version` can't run sessionlore, or null if it can. */
export function unsupportedNodeMessage(version: string): string | null {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  const [needMajor = 0, needMinor = 0] = REQUIRED_NODE_VERSION.split(".").map(Number);
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return null;
  return (
    `sessionlore requires Node.js ${REQUIRED_NODE_VERSION} or newer, but this is Node.js ${version.replace(/^v/, "")}.\n` +
    `Install a newer Node.js (https://nodejs.org) and run sessionlore again.\n`
  );
}
