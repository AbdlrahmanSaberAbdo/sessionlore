import type { AcceptResult, Overview, ReviewQueue, SessionView, SuggestionReview, WorkflowDetail, WorkflowList } from "@sessionlore/core";
import { useEffect, useState, type ReactNode } from "react";
import { sendJson, useApi, type Loaded } from "./api.js";
import { Rail, type RailSection } from "./components/rail.js";
import { filterQuery, Link, parseFilter, useLocation } from "./router.js";
import { CorrectionsScreen } from "./screens/corrections.js";
import { PendingScreen, ReviewScreen, type ReviewActions } from "./screens/review.js";
import { SessionScreen } from "./screens/sessions.js";
import { WorkflowScreen, WorkflowsScreen } from "./screens/workflows.js";

export { navigate } from "./router.js";

/**
 * The dashboard shell: the rail and one screen per path. A screen is a
 * component that loads its data through the API and renders a presentational
 * component (the part the smoke test renders). Add screens to `screens`.
 */

interface Screen {
  /** A path such as `/workflows`, or a pattern with `:param` segments such as `/workflows/:id`. */
  path: string;
  title: string;
  /** The rail entry it belongs to: `/workflows/4` is under Workflows. */
  section: RailSection | null;
  render(params: Record<string, string>, search: string, changed: () => void): ReactNode;
}

const screens: Screen[] = [
  { path: "/", title: "Home", section: "/", render: () => <PendingPage /> },
  { path: "/workflows", title: "Workflows", section: "/workflows", render: (_, search) => <WorkflowsPage search={search} /> },
  {
    path: "/workflows/:id",
    title: "Workflow",
    section: "/workflows",
    render: ({ id }, search) => <WorkflowPage id={id!} search={search} />,
  },
  { path: "/corrections", title: "Corrections", section: "/corrections", render: () => <CorrectionsScreen /> },
  { path: "/sessions/:id", title: "Session", section: null, render: ({ id }) => <SessionPage id={id!} /> },
  {
    path: "/suggestions/:id",
    title: "Suggestion",
    section: "/",
    render: ({ id }, _, changed) => <ReviewPage key={id} id={id!} changed={changed} />,
  },
];

function PendingPage() {
  return <Load loaded={useApi<ReviewQueue>("/api/suggestions")}>{(queue) => <PendingScreen queue={queue} />}</Load>;
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

function SessionPage({ id }: { id: string }) {
  const loaded = useApi<SessionView>(`/api/sessions/${encodeURIComponent(id)}`);
  // Links to a Task end in #task-N; scroll there once the Session has rendered.
  useEffect(() => {
    if (loaded.state === "ready" && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [loaded.state]);
  return <Load loaded={loaded}>{(session) => <SessionScreen session={session} />}</Load>;
}

function ReviewPage({ id, changed }: { id: string; changed: () => void }) {
  const path = `/api/suggestions/${encodeURIComponent(id)}`;
  const [version, setVersion] = useState(0);
  const [outcome, setOutcome] = useState<{ notice?: string; error?: string }>({});
  const loaded = useApi<SuggestionReview>(path, version);
  /** Runs one review action, then shows what it did and reloads the Suggestion. */
  const act = (action: () => Promise<string>) => async () => {
    try {
      setOutcome({ notice: await action() });
      setVersion((v) => v + 1);
      changed();
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
  // Bumped after a review action, so the rail's Pending count stays current.
  const [version, setVersion] = useState(0);
  const changed = () => setVersion((v) => v + 1);
  useEffect(() => {
    document.title = matched ? `${matched.screen.title} · sessionlore` : "sessionlore";
  }, [matched?.screen]);
  return (
    <div className="shell">
      <LoadedRail section={matched?.screen.section ?? null} version={version} />
      <main className="page">
        {matched ? (
          matched.screen.render(matched.params, search, changed)
        ) : (
          <p className="muted">
            Nothing here. Go to <Link href="/">Home</Link>.
          </p>
        )}
      </main>
    </div>
  );
}

/** The rail, with the Pending count and what was read. */
function LoadedRail({ section, version }: { section: RailSection | null; version: number }) {
  const overview = useApi<Overview>("/api/overview", version);
  const queue = useApi<ReviewQueue>("/api/suggestions", version);
  return (
    <Rail
      section={section}
      pending={queue.state === "ready" ? queue.data.suggestions.length : null}
      counts={overview.state === "ready" ? overview.data.counts : null}
    />
  );
}
