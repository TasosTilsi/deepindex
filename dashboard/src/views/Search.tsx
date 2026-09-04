import { useEffect, useState } from 'react';
import { withProject } from '../util';

interface Related { id: string; name: string; type: string; relationship: string }
interface Hit { id: string; type: string; name: string; content: string; commitSha: string | null; rank: number; related: Related[] }

interface Props {
  qs: string;
  initialQuery: string;
  onSelectEntity(id: string): void;
  onOpenInGraph(id: string): void;
}

export default function Search({ qs, initialQuery, onSelectEntity, onOpenInGraph }: Props) {
  const [q, setQ] = useState(initialQuery);
  const [results, setResults] = useState<Hit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (query: string) => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(withProject(`/api/search?q=${encodeURIComponent(query)}&limit=20`, qs));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setResults(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Re-run when the topbar submits a new query (initialQuery changes).
  useEffect(() => {
    setQ(initialQuery);
    if (initialQuery.trim()) void run(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery, qs]);

  return (
    <>
      <div className="view-header">
        <h1>Semantic Search</h1>
      </div>
      <p className="sub">Full-text search across the knowledge graph.</p>
      <input
        className="search-input"
        placeholder="Search entities…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void run(q)}
      />
      {results && (
        <div className="search-meta">
          <span>Found: <strong style={{ color: 'var(--text-dim)' }}>{results.length} nodes</strong></span>
        </div>
      )}
      {loading && <div className="state"><h2>Searching…</h2></div>}
      {error && <div className="state"><h2>Could not load data</h2><p>{error}</p></div>}
      {results && results.length === 0 && <div className="state"><h2>No results</h2><p>Try a different query.</p></div>}
      {results?.map((h) => (
        <div key={h.id} className="result" onClick={() => onSelectEntity(h.id)}>
          <div className="result-name">
            <span className={`tag tag-${h.type}`}>{h.type.replace('_', ' ')}</span> {h.name}
          </div>
          <div className="result-content">{h.content}</div>
          {h.related.length > 0 && (
            <div className="chips" style={{ marginBottom: 10 }}>
              {h.related.slice(0, 6).map((r) => (
                <span key={`${r.id}-${r.relationship}`} className="chip">{r.relationship.replace('inverse:', '')}: {r.name}</span>
              ))}
            </div>
          )}
          <div className="result-actions">
            <button
              className="btn btn-accent"
              onClick={(e) => { e.stopPropagation(); onOpenInGraph(h.id); }}
            >
              <span className="material-symbols-outlined">account_tree</span> View in Graph
            </button>
            <span className="mono-label">rank {h.rank.toFixed(2)}</span>
          </div>
        </div>
      ))}
    </>
  );
}