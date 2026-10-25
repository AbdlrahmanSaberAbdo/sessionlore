import type { Overview, SessionList, SessionView, WorkflowDetail, WorkflowList } from "@sessionlore/core";
import { useEffect, type ReactNode } from "react";
import { useApi, type Loaded } from "./api.js";
import { filterQuery, navigate, parseFilter, useLocation } from "./router.js";
import { OverviewScreen } from "./screens/overview.js";
import { SessionScreen, SessionsScreen } from "./screens/sessions.js";
import { WorkflowScreen, WorkflowsScreen } from "./screens/workflows.js";

export { navigate } from "./router.js";

/**
 * The dashboard shell: navigation and one screen per path. A screen is a
 * component that loads its data through the API and renders a presentational
 * component (the part the smoke test renders). Add screens to `screens`.
 */

interface Screen {
  /** A path such as `/workflows`, or a pattern with `:param` segments such as `/workflows/:id`. */
  path: string;
  title: string;
  /** Shown in the navigation; screens reached through a link (with params) are not. */
  nav: boolean;
  render(params: Record<string, string>, search: string): ReactNode;
}

const screens: Screen[] = [
  { path: "/", title: "Overview", nav: true, render: () => <OverviewPage /> },
  { path: "/workflows", title: "Workflows", nav: true, render: (_, search) => <WorkflowsPage search={search} /> },
  {
    path: "/workflows/:id",
    title: "Workflow",
    nav: false,
    render: ({ id }, search) => <WorkflowPage id={id!} search={search} />,
  },
  { path: "/sessions", title: "Sessions", nav: true, render: (_, search) => <SessionsPage search={search} /> },
  { path: "/sessions/:id", title: "Session", nav: false, render: ({ id }) => <SessionPage id={id!} /> },
];

function OverviewPage() {
  return <Load loaded={useApi<Overview>("/api/overview")}>{(overview) => <OverviewScreen overview={overview} />}</Load>;
}

function WorkflowsPage({ search }: { search: string }) {
  const filter = parseFilter(search);
  return (
    <Load loaded={useApi<WorkflowList>(`/api/workflows${filterQuery(filter)}`)}>
      {(list) => <WorkflowsScreen list={list} filter={filter} />}
    </Load>
  );
}

function WorkflowPage({ id, search }: { id: string; search: string }) {
  const filter = parseFilter(search);
  return (
    <Load loaded={useApi<WorkflowDetail>(`/api/workflows/${encodeURIComponent(id)}${filterQuery(filter)}`)}>
      {(workflow) => <WorkflowScreen workflow={workflow} filter={filter} />}
    </Load>
  );
}

function SessionsPage({ search }: { search: string }) {
  const filter = parseFilter(search);
  return (
    <Load loaded={useApi<SessionList>(`/api/sessions${filterQuery(filter)}`)}>
      {(list) => <SessionsScreen list={list} filter={filter} />}
    </Load>
  );
}

function SessionPage({ id }: { id: string }) {
  const loaded = useApi<SessionView>(`/api/sessions/${encodeURIComponent(id)}`);
  // Links to a Task end in #task-N; scroll there once the Session has rendered.
  useEffect(() => {
    if (loaded.state === "ready" && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [loaded.state]);
  return <Load loaded={loaded}>{(session) => <SessionScreen session={session} />}</Load>;
}

/** Shows a loading or error state until the data is ready. */
export function Load<T>({ loaded, children }: { loaded: Loaded<T>; children: (data: T) => ReactNode }) {
  if (loaded.state === "loading") return <p className="muted">Loading…</p>;
  if (loaded.state === "error") return <p className="error">Could not load: {loaded.message}</p>;
  return <>{children(loaded.data)}</>;
}

/** The screen for `path` and the values of its `:param` segments. */
function route(path: string): { screen: Screen; params: Record<string, string> } | null {
  const segments = path.split("/").filter(Boolean);
  for (const screen of screens) {
    const pattern = screen.path.split("/").filter(Boolean);
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const matches = pattern.every((part, i) => {
      if (part.startsWith(":")) {
        params[part.slice(1)] = decodeURIComponent(segments[i]!);
        return true;
      }
      return part === segments[i];
    });
    if (matches) return { screen, params };
  }
  return null;
}

export function Dashboard() {
  const { path, search } = useLocation();
  const matched = route(path);
  const section = "/" + (path.split("/")[1] ?? "");
  useEffect(() => {
    document.title = matched ? `${matched.screen.title} · sessionlore` : "sessionlore";
  }, [matched?.screen]);
  return (
    <>
      <header className="top">
        <span className="brand">sessionlore</span>
        <nav>
          {screens
            .filter((s) => s.nav)
            .map((s) => (
              <a
                key={s.path}
                href={s.path}
                aria-current={s.path === section ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(s.path);
                }}
              >
                {s.title}
              </a>
            ))}
        </nav>
      </header>
      <main>
        {matched ? matched.screen.render(matched.params, search) : <p className="muted">Nothing here. Pick a screen above.</p>}
      </main>
    </>
  );
}
