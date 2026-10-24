import { useEffect, useState } from "react";

/**
 * Reads the dashboard's JSON API. Response types are the App's own types from
 * @sessionlore/core (type-only imports, so no core code reaches the browser).
 */

export type Loaded<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: T };

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `${path} answered ${response.status}`);
  return body as T;
}

/** Fetches `path` once per change of `path`. */
export function useApi<T>(path: string): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: "loading" });
  useEffect(() => {
    let current = true;
    setLoaded({ state: "loading" });
    getJson<T>(path).then(
      (data) => current && setLoaded({ state: "ready", data }),
      (error: unknown) => current && setLoaded({ state: "error", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      current = false;
    };
  }, [path]);
  return loaded;
}
