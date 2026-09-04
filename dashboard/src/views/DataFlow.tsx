import { useEffect, useRef } from 'react';
import { Network } from 'vis-network/standalone';
import { useApi, State } from '../useApi';

interface Table { name: string; queryIds: number[]; }
interface Query { id: number; file: string; }
interface Service { file: string; service: string; }
interface DataflowData { tables: Table[]; queries: Query[]; services: Service[]; }

export default function DataFlow() {
  const { data, loading, error } = useApi<DataflowData>('/api/dataflow');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!data || !ref.current) return;
    const nodes: { id: string; label: string; color: { background: string; border: string }; font: { color: string; size: number } }[] = [];
    const edges: { from: string; to: string; arrows: string; color: { color: string } }[] = [];

    for (const t of data.tables) {
      nodes.push({ id: `t:${t.name}`, label: t.name, color: { background: '#1f6c9f', border: '#111111' }, font: { color: '#fff', size: 12 } });
      for (const qid of t.queryIds) edges.push({ from: `t:${t.name}`, to: `q:${qid}`, arrows: 'to', color: { color: '#d0d0d0' } });
    }
    for (const q of data.queries) {
      nodes.push({ id: `q:${q.id}`, label: `query ${q.id}`, color: { background: '#346538', border: '#111111' }, font: { color: '#fff', size: 11 } });
      edges.push({ from: `q:${q.id}`, to: `f:${q.file}`, arrows: 'to', color: { color: '#d0d0d0' } });
    }
    for (const s of data.services) {
      nodes.push({ id: `f:${s.file}`, label: s.service || s.file, color: { background: '#956400', border: '#111111' }, font: { color: '#fff', size: 11 } });
    }

    new Network(ref.current, { nodes, edges }, {
      physics: { stabilization: true },
      nodes: { shape: 'dot', size: 14 },
    });
  }, [data]);

  return (
    <State loading={loading} error={error}>
      <h1>Data Flow</h1>
      <p className="sub">Table ↔ Query ↔ Service relationships.</p>
      {data && data.tables.length === 0 ? (
        <div className="state"><h2>No data-flow indexed</h2><p>Index a repo with SQL/data-flow to see the graph.</p></div>
      ) : (
        <div className="graph" ref={ref} />
      )}
    </State>
  );
}
