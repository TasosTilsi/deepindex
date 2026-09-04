import { useEffect, useRef } from 'react';
import { Network } from 'vis-network/standalone';
import { useApi, State } from '../useApi';

interface Entity { id: string; type: string; name: string; content: string; }
interface Backlink { from_id: string; to_id: string; relationship: string; }
interface EntitiesData { entities: Entity[]; backlinks: Backlink[]; }

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

export default function KnowledgeGraph() {
  const { data, loading, error } = useApi<EntitiesData>('/api/entities?limit=200');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!data || !ref.current) return;
    const nodes = data.entities.map((e) => ({
      id: e.id,
      label: e.name,
      color: { background: TYPE_COLOR[e.type] ?? '#787774', border: '#111111' },
      font: { color: '#ffffff', size: 12 },
      title: `${e.type}: ${e.content}`,
    }));
    const edges = data.backlinks.map((b) => ({
      from: b.from_id,
      to: b.to_id,
      label: b.relationship.replace('inverse:', ''),
      arrows: 'to',
      color: { color: '#d0d0d0' },
      font: { size: 10, color: '#787774' },
    }));
    new Network(ref.current, { nodes, edges }, {
      physics: { stabilization: true },
      nodes: { shape: 'dot', size: 14 },
    });
  }, [data]);

  return (
    <State loading={loading} error={error}>
      <h1>Knowledge Graph</h1>
      <p className="sub">Entities and their relationships.</p>
      {data && data.entities.length === 0 ? (
        <div className="state"><h2>No data indexed</h2><p>Run <code>deepindex index &lt;repo&gt;</code> to build the index, then refresh.</p></div>
      ) : (
        <div className="graph" ref={ref} />
      )}
    </State>
  );
}
