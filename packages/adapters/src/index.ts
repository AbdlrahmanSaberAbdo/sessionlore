import type { Adapter } from "@sessionlore/core";
import { claudeCodeAdapter } from "./claude-code/adapter.js";
import { cursorAdapter } from "./cursor/adapter.js";

export { claudeCodeAdapter, cursorAdapter };

/** Every Adapter sessionlore ships, in the order Scan runs them. */
export const allAdapters: readonly Adapter[] = [claudeCodeAdapter, cursorAdapter];
