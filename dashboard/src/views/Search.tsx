import { useState } from 'react';

interface Related { id: string; name: string; type: string; relationship: string; }
interface Hit { id: string; type: string; name: string; content: string; related: Related[]; }

export default function Search() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Hit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=20`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setResults(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <h1>Search</h1>
      <p className="sub">Search the knowledge graph.</p>
      <input
        className="search-input"
        placeholder="Search entities…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && run()}
      />
      {loading && <div className="state"><h2>Searching…</h2></div>}
      {error && <div className="state"><h2>Could not load data</h2><p>{error}</p></div>}
      {results && results.length === 0 && <div className="state"><h2>No results</h2><p>Try a different query.</p></div>}
      {results?.map((h) => (
        <div className="result" key={h.id}>
          <div className="result-name">
            <span className={`tag tag-${h.type}`}>{h.type}</span> {h.name}
          </div>
          <div className="result-content">{h.content}</div>
          {h.related.length > 0 && (
            <div className="result-content" style={{ marginTop: 8 }}>
              Related: {h.related.map((r) => `${r.relationship} ${r.name}`).join(', ')}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
