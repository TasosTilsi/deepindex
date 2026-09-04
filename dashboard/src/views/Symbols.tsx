import { useApi, State } from '../useApi';

interface File { id: number; path: string; language: string | null; }
interface Symbol { id: number; name: string; kind: string; file_id: number; path: string; }
interface SymbolsData { files: File[]; symbols: Symbol[]; }

export default function Symbols({ qs = '' }: { qs?: string }) {
  const { data, loading, error } = useApi<SymbolsData>(`/api/symbols?limit=500${qs}`);
  return (
    <State loading={loading} error={error}>
      <h1>Symbols</h1>
      <p className="sub">Files and their symbols.</p>
      {data && data.symbols.length === 0 ? (
        <div className="state"><h2>No data indexed</h2><p>Run <code>deepindex index &lt;repo&gt;</code> to build the index, then refresh.</p></div>
      ) : (
        <table>
          <thead>
            <tr><th>Symbol</th><th>Kind</th><th>File</th></tr>
          </thead>
          <tbody>
            {data?.symbols.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.name}</td>
                <td>{s.kind}</td>
                <td className="mono">{s.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </State>
  );
}
