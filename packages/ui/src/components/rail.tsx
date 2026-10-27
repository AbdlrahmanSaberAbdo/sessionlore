import type { Overview } from "@sessionlore/core";
import { Link } from "../router.js";
import { plural } from "./filters.js";

/** The rail's entries, in order. */
export const railEntries = [
  { path: "/", title: "Home" },
  { path: "/workflows", title: "Workflows" },
  { path: "/corrections", title: "Corrections" },
] as const;

export type RailSection = (typeof railEntries)[number]["path"];

/**
 * The wordmark, Home with the Pending count, Workflows, Corrections, and how
 * much was read; a top bar on narrow windows. Counts are null until loaded.
 */
export function Rail({ section, pending, counts }: { section: RailSection | null; pending: number | null; counts: Overview["counts"] | null }) {
  return (
    <nav className="rail" aria-label="Main">
      <Link href="/" className="wordmark">
        sessionlore
      </Link>
      {railEntries.map((entry) => (
        <Link key={entry.path} href={entry.path} className="nav" current={entry.path === section}>
          {entry.title}
          {entry.path === "/" && pending ? <span className="count">{pending}<span className="visually-hidden"> Pending</span></span> : null}
        </Link>
      ))}
      {counts ? (
        <p className="read-from">
          Read from {plural(counts.sessions, "Session")} and {plural(counts.tasks, "Task")}
        </p>
      ) : null}
    </nav>
  );
}
