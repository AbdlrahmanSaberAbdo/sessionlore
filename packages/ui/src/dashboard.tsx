import type {
  AcceptResult,
  MindMap,
  Overview,
  ReviewQueue,
  SessionList,
  SessionView,
  SuggestionReview,
  WorkflowDetail,
  WorkflowList,
} from "@sessionlore/core";
import { useEffect, useState, type ReactNode } from "react";
import { sendJson, useApi, type Loaded } from "./api.js";
import { filterQuery, navigate, parseFilter, useLocation } from "./router.js";
import { MindMapScreen } from "./screens/mind-map.js";
import { OverviewScreen } from "./screens/overview.js";
import { ReviewQueueScreen, ReviewScreen, type ReviewActions } from "./screens/review.js";
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
  { path: "/mind-map", title: "Mind map", nav: true, render: (_, search) => <MindMapPage search={search} /> },
  { path: "/sessions/:id", title: "Session", nav: false, render: ({ id }) => <SessionPage id={id!} /> },
  { path: "/suggestions", title: "Review", nav: true, render: () => <ReviewQueuePage /> },
  { path: "/suggestions/:id", title: "Suggestion", nav: false, render: ({ id }) => <ReviewPage key={id} id={id!} /> },
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

function MindMapPage({ search }: { search: string }) {
  const filter = parseFilter(search);
  return (
    <Load loaded={useApi<MindMap>(`/api/mind-map${filterQuery(filter)}`)}>
      {/* Keyed by the filter so a new map starts with its own collapse state. */}
      {(map) => <MindMapScreen key={search} map={map} filter={filter} />}
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

function ReviewQueuePage() {
  return <Load loaded={useApi<ReviewQueue>("/api/suggestions")}>{(queue) => <ReviewQueueScreen queue={queue} />}</Load>;
}

function ReviewPage({ id }: { id: string }) {
  const path = `/api/suggestions/${encodeURIComponent(id)}`;
  const [version, setVersion] = useState(0);
  const [outcome, setOutcome] = useState<{ notice?: string; error?: string }>({});
  const loaded = useApi<SuggestionReview>(path, version);
  /** Runs one review action, then shows what it did and reloads the Suggestion. */
  const act = (action: () => Promise<string>) => async () => {
    try {
      setOutcome({ notice: await action() });
      setVersion((v) => v + 1);
    } catch (error) {
      setOutcome({ error: error instanceof Error ? error.message : String(error) });
    }
  };
  const actions: ReviewActions = {
    save: (form) => act(() => sendJson("PUT", path, form).then(() => "Saved your changes."))(),
    setScope: (choice) => act(() => sendJson("PUT", `${path}/scope`, choice).then(() => "Scope changed."))(),
    accept: act(async () => {
      const result = await sendJson<AcceptResult>("POST", `${path}/accept`);
      const backedUp = result.backups.length > 0 ? ` Backed up ${result.backups.length} existing file(s); \`sessionlore restore ${id}\` puts them back.` : "";
      return `Accepted. Wrote ${result.files.map((f) => f.path).join(", ")}.${backedUp}`;
    }),
    reject: act(() => sendJson("POST", `${path}/reject`).then(() => "Rejected. It won't be suggested again.")),
  };
  return (
    <Load loaded={loaded}>
      {(review) => <ReviewScreen review={review} actions={actions} notice={outcome.notice} error={outcome.error} />}
    </Load>
  );
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
