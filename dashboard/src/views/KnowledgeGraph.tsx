import { useEffect, useRef, useState } from 'react';
import { Network } from 'vis-network/standalone';
import { useApi, State } from '../useApi';
import { withProject } from '../util';

interface Entity { id: string; type: string; name: string; content: string }
interface Backlink { from_id: string; to_id: string; relationship: string }
interface EntitiesData { entities: Entity[]; backlinks: Backlink[] }

const TYPE_COLOR: Record<string, string> = {
  decision: '#1f6c9f',
  bug_fix: '#9f2f2d',
  pattern: '#346538',
  tech_debt: '#956400',
  breaking_change: '#9f2f2d',
  security_fix: '#9f2f2d',
  workflow: '#1f6c9f',
  concept: '#787774',
};

export default function KnowledgeGraph({ qs, onSelectEntity }: { qs: string; onSelectEntity(id: string): void }) {
  const { data, loading, error } = useApi<EntitiesData>(withProject('/api/entities?limit=200', qs));
  const ref = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<string>('all');

  const types = ['all', ...new Set((data?.entities ?? []).map((e) => e.type))];

  useEffect(() => {
    if (!data || !ref.current) return;
    const inSet = (e: Entity) => filter === 'all' || e.type === filter;
    const nodes = data.entities.filter(inSet).map((e) => ({
      id: e.id,
      label: e.name,
      color: {
        background: TYPE_COLOR[e.type] ?? '#787774',
        border: '#ffffff',
        highlight: { background: TYPE_COLOR[e.type] ?? '#787774', border: '#111111' },
      },
      font: { color: '#111111', size: 11, face: 'JetBrains Mono', strokeWidth: 4, strokeColor: '#ffffff' },
      title: `${e.type}: ${e.content.slice(0, 200)}`,
    }));
    const ids = new Set(nodes.map((n) => n.id));
    // Only draw edges whose endpoints survive the filter — orphan edges are
    // both useless and vis-network's slowest render path.
    const edges = data.backlinks
      .filter((b) => ids.has(b.from_id) && ids.has(b.to_id))
      .map((b) => ({
        from: b.from_id,
        to: b.to_id,
        title: b.relationship.replace('inverse:', ''),
        arrows: 'to',
        color: { color: 'rgba(17,17,17,0.18)', highlight: '#111111' },
      }));
    const network = new Network(ref.current, { nodes, edges }, {
      physics: { stabilization: { enabled: true, iterations: 200 } },
      nodes: { shape: 'dot', size: 13 },
      interaction: { hover: true },
    });
    // Freeze the simulation once the initial layout settles — vis keeps
    // simulating forever otherwise, so nodes visibly drift post-load.
    network.once('stabilizationIterationsDone', () => {
      network.setOptions({ physics: { enabled: false } });
    });
    network.on('click', (params) => {
      const id = params.nodes?.[0];
      if (typeof id === 'string') onSelectEntity(id);
    });
    return () => network.destroy();
  }, [data, filter, onSelectEntity]);

  return (
    <State loading={loading} error={error}>
      <div className="view-header">
        <h1>Knowledge Graph</h1>
      </div>
      <p className="sub">Entities and their relationships. Click a node for details.</p>
      {data && data.entities.length === 0 ? (
        <div className="state"><h2>No data indexed</h2><p>Run <code>deepindex index &lt;repo&gt;</code> to build the index.</p></div>
      ) : (
        <div className="graph" ref={ref}>
          <div className="graph-toolbar">
            {types.map((t) => (
              <button key={t} className={`filter-btn ${filter === t ? 'on' : ''}`} onClick={() => setFilter(t)}>
                {t === 'all' ? 'All' : t.replace('_', ' ')}
              </button>
            ))}
          </div>
          <div className="graph-legend">
            <h4 className="mono-label" style={{ marginBottom: 6 }}>Legend</h4>
            {[...new Set((data?.entities ?? []).map((e) => e.type))].slice(0, 8).map((t) => (
              <div key={t} className="legend-item">
                <span className="swatch" style={{ background: TYPE_COLOR[t] ?? '#94a3b8' }} />
                {t.replace('_', ' ')}
              </div>
            ))}
          </div>
        </div>
      )}
    </State>
  );
}