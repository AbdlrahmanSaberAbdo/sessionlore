import type { Overview } from "@sessionlore/core";
import type { ReactNode } from "react";
import { Link } from "../router.js";
import { plural } from "./filters.js";

/** The rail's entries, in order, each with its stroke icon. */
export const railEntries = [
  { path: "/", title: "Home", icon: <path d="M2.5 7L8 2.5 13.5 7v6.5h-11z" strokeLinejoin="round" /> },
  { path: "/workflows", title: "Workflows", icon: <path d="M3 4h10M3 8h10M3 12h6" strokeLinecap="round" /> },
  { path: "/corrections", title: "Corrections", icon: <path d="M3 13l2.5-.5L13 5 11 3 3.5 10.5z" strokeLinejoin="round" /> },
] as const;

export type RailSection = (typeof railEntries)[number]["path"];

type Counts = Overview["counts"];

/** The wordmark and how much was read. Counts are null until loaded. */
export function TopBar({ counts }: { counts: Counts | null }) {
  return (
    <header className="topbar">
      <Link href="/" className="wordmark">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <rect className="logo-lines" x="1" y="1" width="20" height="20" rx="6" strokeWidth="1.6" />
          <path className="logo-lines" d="M6 8h10M6 11h6M6 14h8" strokeWidth="1.6" strokeLinecap="round" />
          <circle className="logo-dot" cx="16" cy="14" r="1.6" />
        </svg>
        sessionlore
      </Link>
      {counts ? (
        <p className="read-from">
          Read from {plural(counts.sessions, "Session")} and {plural(counts.tasks, "Task")}
        </p>
      ) : null}
    </header>
  );
}

/**
 * Home with the Pending count, Workflows with how many there are, and
 * Corrections; tabs under the top bar on narrow windows.
 */
export function Rail({ section, pending, counts }: { section: RailSection | null; pending: number | null; counts: Counts | null }) {
  const count = (path: RailSection): ReactNode => {
    if (path === "/" && pending) {
      return (
        <span className="count pending">
          {pending}
          <span className="visually-hidden"> Pending</span>
        </span>
      );
    }
    if (path === "/workflows" && counts) return <span className="count">{counts.workflows}</span>;
    return null;
  };
  return (
    <nav className="rail" aria-label="Main">
      {railEntries.map((entry) => (
        <Link key={entry.path} href={entry.path} className="nav" current={entry.path === section}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            {entry.icon}
          </svg>
          {entry.title}
          {count(entry.path)}
        </Link>
      ))}
    </nav>
  );
}
