import { useState } from 'react';
import { useApi, State } from '../useApi';
import { withProject, timeAgo } from '../util';

interface Entity { id: string; type: string; name: string; content: string; created_at?: string }

export default function Entities({ qs, onSelectEntity }: { qs: string; onSelectEntity(id: string): void }) {
  const { data, loading, error } = useApi<{ entities: Entity[] }>(withProject('/api/entities?limit=200', qs));
  const [filter, setFilter] = useState<string>('all');
  const types = ['all', ...new Set((data?.entities ?? []).map((e) => e.type))];
  const shown = (data?.entities ?? []).filter((e) => filter === 'all' || e.type === filter);
  return (
    <State loading={loading} error={error}>
      <div className="view-header">
        <h1>Entities</h1>
      </div>
      <p className="sub">Knowledge extracted from your repo's history — decisions, patterns, bugs, concepts.</p>
      {data && data.entities.length === 0 ? (
        <div className="state"><h2>No entities indexed</h2><p>Run <code>deepindex index &lt;repo&gt;</code> to build the index.</p></div>
      ) : (
        <>
          <div className="graph-toolbar" style={{ position: 'static', marginBottom: 16, display: 'inline-flex' }}>
            {types.map((t) => (
              <button key={t} className={`filter-btn ${filter === t ? 'on' : ''}`} onClick={() => setFilter(t)}>
                {t === 'all' ? 'All' : t.replace('_', ' ')}
              </button>
            ))}
          </div>
          <div className="entity-grid">
            {shown.map((e) => (
              <div key={e.id} className="entity-card" onClick={() => onSelectEntity(e.id)}>
                <span className={`tag tag-${e.type}`}>{e.type.replace('_', ' ')}</span>
                <span className="entity-name">{e.name}</span>
                <span className="entity-content">{e.content}</span>
                {e.created_at && <span className="mono-label">{timeAgo(e.created_at)}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </State>
  );
}