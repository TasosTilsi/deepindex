import { useEffect, useRef } from 'react';
import { Network } from 'vis-network/standalone';
import { useApi, State } from '../useApi';
import { withProject } from '../util';

interface Table { name: string; queryIds: number[]; }
interface Query { id: number; file: string; }
interface Service { file: string; service: string; }
interface DataflowData { tables: Table[]; queries: Query[]; services: Service[]; }

export default function DataFlow({ qs = '' }: { qs?: string }) {
  const { data, loading, error } = useApi<DataflowData>(withProject('/api/dataflow', qs));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!data || !ref.current) return;
    const nodes: { id: string; label: string; color: { background: string; border: string }; font: { color: string; size: number; strokeWidth: number; strokeColor: string } }[] = [];
    const edges: { from: string; to: string; arrows: string; color: { color: string } }[] = [];

    const nodeIds = new Set<string>();
    // Labels carry a white stroke halo: in a fitted dense graph the text
    // collides with the dark node fills, and a bare dark label smudges into
    // them. The halo keeps names readable over any background.
    const addNode = (id: string, label: string, background: string, fontSize: number) => {
      nodeIds.add(id);
      nodes.push({
        id,
        label,
        color: { background, border: '#ffffff' },
        font: { color: '#111111', size: fontSize, strokeWidth: 4, strokeColor: '#ffffff' },
      });
    };

    for (const t of data.tables) {
      addNode(`t:${t.name}`, t.name, '#1f6c9f', 12);
      for (const qid of t.queryIds) edges.push({ from: `t:${t.name}`, to: `q:${qid}`, arrows: 'to', color: { color: '#c9c8c4' } });
    }
    for (const q of data.queries) {
      addNode(`q:${q.id}`, `query ${q.id}`, '#346538', 11);
      edges.push({ from: `q:${q.id}`, to: `f:${q.file}`, arrows: 'to', color: { color: '#c9c8c4' } });
    }
    for (const s of data.services) {
      addNode(`f:${s.file}`, s.service || s.file, '#956400', 11);
    }
    // vis cannot draw an edge whose endpoint node is missing — drop orphans
    // instead of failing the whole render.
    const drawable = edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

    const network = new Network(ref.current, { nodes, edges: drawable }, {
      physics: { stabilization: { enabled: true, iterations: 200 } },
      nodes: { shape: 'dot', size: 14 },
    });
    // Freeze the simulation once the initial layout settles — vis keeps
    // simulating forever otherwise, so nodes visibly drift post-load.
    network.once('stabilizationIterationsDone', () => {
      network.setOptions({ physics: { enabled: false } });
    });
    return () => network.destroy();
  }, [data]);

  return (
    <State loading={loading} error={error}>
      <div className="view-header">
        <h1>Data Flow</h1>
      </div>
      <p className="sub">Table ↔ Query ↔ Service relationships.</p>
      {data && data.tables.length === 0 ? (
        <div className="state"><h2>No data-flow indexed</h2><p>Index a repo with SQL/data-flow to see the graph.</p></div>
      ) : (
        <div className="graph" ref={ref} />
      )}
    </State>
  );
}
