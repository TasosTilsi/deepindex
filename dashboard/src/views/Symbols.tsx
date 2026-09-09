import { useApi, State } from '../useApi';
import { withProject } from '../util';

interface File { id: number; path: string; language: string | null; }
interface Symbol { id: number; name: string; kind: string; file_id: number; path: string; }
interface SymbolsData { files: File[]; symbols: Symbol[]; }

interface Props {
  qs?: string;
  /** UI-SPEC §3 DELTA + R-B1: search symbol/file hits land here with an exact
   *  path filter; nav landing passes no path → unfiltered. State is lifted in
   *  App — the chip's × calls onClearFilter so it cannot resurrect. */
  initialPath?: string;
  onClearFilter?: () => void;
}

export default function Symbols({ qs = '', initialPath, onClearFilter }: Props) {
  const { data, loading, error } = useApi<SymbolsData>(withProject('/api/symbols?limit=500', qs));
  // U-4: exact client-side match on Symbol.path.
  const filtered = initialPath ? data?.symbols.filter((s) => s.path === initialPath) : data?.symbols;
  return (
    <State loading={loading} error={error}>
      <div className="view-header">
        <h1>Symbols</h1>
      </div>
      <p className="sub">Files and their symbols.</p>
      {initialPath ? (
        <div className="chips" style={{ marginBottom: 12 }}>
          <span className="chip">
            {initialPath}
            {onClearFilter && (
              <button
                title="Clear path filter"
                aria-label={`Clear path filter ${initialPath}`}
                onClick={onClearFilter}
                style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 10, padding: '0 0 0 6px' }}
              >×</button>
            )}
          </span>
        </div>
      ) : null}
      {/* E-16/R-W9: filter matching no symbols keeps the existing empty state + the clear chip. */}
      {data && (filtered?.length ?? 0) === 0 ? (
        <div className="state"><h2>No data indexed</h2><p>Run <code>deepindex index &lt;repo&gt;</code> to build the index, then refresh.</p></div>
      ) : (
        <table>
          <thead>
            <tr><th>Symbol</th><th>Kind</th><th>File</th></tr>
          </thead>
          <tbody>
            {filtered?.map((s) => (
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
