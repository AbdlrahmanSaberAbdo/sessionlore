import type { BrowseFilter } from "@sessionlore/core";
import { useEffect, useState, type ReactNode } from "react";

/** Client-side navigation: the server answers every UI path with index.html. */
export function navigate(path: string) {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

/** The current path and query string, updated on navigation. */
export function useLocation(): { path: string; search: string } {
  const read = () => ({ path: location.pathname, search: location.search });
  const [current, setCurrent] = useState(read);
  useEffect(() => {
    const update = () => setCurrent(read());
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  return current;
}

/** A link that navigates without reloading the page. */
export function Link({ href, children, className, current }: { href: string; children: ReactNode; className?: string; current?: boolean }) {
  return (
    <a
      href={href}
      className={className}
      aria-current={current ? "page" : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(href);
        const hash = href.split("#")[1];
        if (hash) document.getElementById(hash)?.scrollIntoView();
      }}
    >
      {children}
    </a>
  );
}

const filterKeys = ["project", "harness", "from", "to"] as const;

/** The filter in a query string such as `?harness=cursor`. */
export function parseFilter(search: string): BrowseFilter {
  const params = new URLSearchParams(search);
  const filter: BrowseFilter = {};
  for (const key of filterKeys) {
    const value = params.get(key);
    if (value) (filter as Record<string, string>)[key] = value;
  }
  return filter;
}

/** `filter` as a query string, starting with `?`, or "" when it is empty. */
export function filterQuery(filter: BrowseFilter): string {
  const params = new URLSearchParams();
  for (const key of filterKeys) if (filter[key]) params.set(key, filter[key]!);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** The review screen of one Suggestion. */
export function suggestionPath(id: number): string {
  return `/suggestions/${id}`;
}

/** The Session viewer's path for a Session, scrolled to one of its Tasks when given. */
export function sessionPath(session: string, taskPosition?: number | null): string {
  const path = `/sessions/${encodeURIComponent(session)}`;
  return taskPosition === undefined || taskPosition === null ? path : `${path}#task-${taskPosition}`;
}
