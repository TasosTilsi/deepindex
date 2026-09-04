import { useEffect, useState } from 'react';

/** Fetch a dashboard API endpoint with loading/error state. */
export function useApi<T>(path: string): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(path)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!cancelled) setData(d as T);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return { data, loading, error };
}

export function State({ loading, error, children }: { loading: boolean; error: string | null; children: React.ReactNode }) {
  if (loading) return <div className="state"><h2>Loading</h2><p>Fetching data…</p></div>;
  if (error) return <div className="state"><h2>Could not load data</h2><p>Check the index exists and the server is running. ({error})</p></div>;
  return <>{children}</>;
}
