import type { Adapter } from "@habitlore/core";
import { claudeCodeAdapter } from "./claude-code/adapter.js";
import { cursorAdapter } from "./cursor/adapter.js";

export { claudeCodeAdapter, cursorAdapter };

/** Every Adapter habitlore ships, in the order Scan runs them. */
export const allAdapters: readonly Adapter[] = [claudeCodeAdapter, cursorAdapter];
