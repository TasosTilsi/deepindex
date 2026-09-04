import { useApi, State } from '../useApi';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface Overview {
  files: number;
  symbols: number;
  entities: number;
  tables: number;
  commits: number;
  entityTypes: { type: string; c: number }[];
}

export default function Overview() {
  const { data, loading, error } = useApi<Overview>('/api/overview');
  return (
    <State loading={loading} error={error}>
      {data && (
        <>
          <h1>Overview</h1>
          <p className="sub">The whole index at a glance.</p>
          <div className="bento">
            <div className="card"><div className="stat-value">{data.files}</div><div className="stat-label">Files</div></div>
            <div className="card"><div className="stat-value">{data.symbols}</div><div className="stat-label">Symbols</div></div>
            <div className="card"><div className="stat-value">{data.entities}</div><div className="stat-label">Entities</div></div>
            <div className="card"><div className="stat-value">{data.tables}</div><div className="stat-label">Tables</div></div>
            <div className="card"><div className="stat-value">{data.commits}</div><div className="stat-label">Commits</div></div>
          </div>
          {data.entityTypes.length > 0 && (
            <div className="card wide">
              <div className="stat-label" style={{ marginBottom: 16 }}>Entities by type</div>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={data.entityTypes}>
                  <XAxis dataKey="type" tick={{ fontSize: 12 }} />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="c" fill="#111111" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
    </State>
  );
}
