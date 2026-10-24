import type { Overview } from "@sessionlore/core";
import { useEffect, useState, type ReactNode } from "react";
import { useApi, type Loaded } from "./api.js";
import { OverviewScreen } from "./screens/overview.js";

/**
 * The dashboard shell: navigation and one screen per path. A screen is a
 * component that loads its data through the API and renders a presentational
 * component (the part the smoke test renders). Add screens to `screens`.
 */

interface Screen {
  path: string;
  title: string;
  render(): ReactNode;
}

const screens: Screen[] = [{ path: "/", title: "Overview", render: () => <OverviewPage /> }];

function OverviewPage() {
  return <Load loaded={useApi<Overview>("/api/overview")}>{(overview) => <OverviewScreen overview={overview} />}</Load>;
}

/** Shows a loading or error state until the data is ready. */
export function Load<T>({ loaded, children }: { loaded: Loaded<T>; children: (data: T) => ReactNode }) {
  if (loaded.state === "loading") return <p className="muted">Loading…</p>;
  if (loaded.state === "error") return <p className="error">Could not load: {loaded.message}</p>;
  return <>{children(loaded.data)}</>;
}

/** Client-side navigation: the server answers every UI path with index.html. */
export function navigate(path: string) {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  return path;
}

export function Dashboard() {
  const path = usePath();
  const screen = screens.find((s) => s.path === path);
  useEffect(() => {
    document.title = screen ? `${screen.title} · sessionlore` : "sessionlore";
  }, [screen]);
  return (
    <>
      <header className="top">
        <span className="brand">sessionlore</span>
        <nav>
          {screens.map((s) => (
            <a
              key={s.path}
              href={s.path}
              aria-current={s === screen ? "page" : undefined}
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
      <main>{screen ? screen.render() : <p className="muted">Nothing here. Pick a screen above.</p>}</main>
    </>
  );
}
