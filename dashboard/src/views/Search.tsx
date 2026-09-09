import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useApi } from '../useApi';
import { withProject } from '../util';

interface Related { id: string; name: string; type: string; relationship: string }
/** Legacy lexical payload (mode=lexical returns searchEntities output verbatim). */
interface LegacyHit { id: string; type: string; name: string; content: string; commitSha: string | null; rank: number; related: Related[] }

type HitKind = 'entity' | 'symbol' | 'module' | 'doc' | 'file';
/** Server HybridHit (UI-SPEC R-B2): provenance-tagged. */
interface HybridHit { kind: HitKind; id: string; label: string; path?: string; score: number; snippet?: string; source: 'vec' | 'lexical' | 'graph' }
interface EmbedStatus {
  available: boolean;
  hint?: string;
  model?: string;
  dim?: number;
  lastEmbedAt?: string;
  coverage?: number;
  staleCount?: number;
  corpusCounts?: { entity: number; symbol: number; module: number; doc: number };
}
type SearchRow = LegacyHit | HybridHit;
type SearchMode = 'lexical' | 'hybrid' | 'semantic';

const isHybrid = (h: SearchRow): h is HybridHit => 'kind' in h;

const MODES: SearchMode[] = ['lexical', 'hybrid', 'semantic'];
const MODE_KEY = 'deepindex.searchMode';
const KIND_FILTERS: { label: string; kind: HitKind | 'all' }[] = [
  { label: 'all', kind: 'all' },
  { label: 'entities', kind: 'entity' },
  { label: 'symbols', kind: 'symbol' },
  { label: 'modules', kind: 'module' },
  { label: 'docs', kind: 'doc' },
  { label: 'files', kind: 'file' },
];

function initialMode(): SearchMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return MODES.includes(v as SearchMode) ? (v as SearchMode) : 'hybrid';
  } catch {
    return 'hybrid';
  }
}

interface Props {
  qs: string;
  initialQuery: string;
  onSelectEntity(id: string): void;
  onOpenInGraph(id: string): void;
  onOpenSymbols(path: string): void;
}

export default function Search({ qs, initialQuery, onSelectEntity, onOpenInGraph, onOpenSymbols }: Props) {
  const [q, setQ] = useState(initialQuery);
  const [results, setResults] = useState<SearchRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<SearchMode>(initialMode);
  const [kindFilter, setKindFilter] = useState<HitKind | 'all'>('all');
  const [lastExecuted, setLastExecuted] = useState('');
  const requestRef = useRef(0);

  const embedStatus = useApi<EmbedStatus>(withProject('/api/embed-status', qs));
  // Only an explicit available:false disables segments — loading/error stay optimistic (UI-SPEC §1.4, E-09).
  const semanticUnavailable = embedStatus.data?.available === false;

  const run = async (query: string) => {
    if (!query.trim()) return;
    const id = ++requestRef.current; // E-08: superseded responses are discarded
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(withProject(`/api/search?q=${encodeURIComponent(query)}&mode=${mode}&limit=20`, qs));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (requestRef.current !== id) return;
      setResults(data);
      setLastExecuted(query);
    } catch (e) {
      if (requestRef.current !== id) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestRef.current === id) setLoading(false);
    }
  };

  // R-W4: project switch clears stale results/error before any re-run (E-14).
  useEffect(() => {
    setResults(null);
    setError(null);
  }, [qs]);

  // Re-run when the topbar submits a new query (initialQuery changes).
  useEffect(() => {
    setQ(initialQuery);
    if (initialQuery.trim()) void run(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery, qs]);

  // R-W3: mode change re-runs the LAST EXECUTED query — drafts (q) are not re-run.
  useEffect(() => {
    if (lastExecuted.trim()) void run(lastExecuted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const changeMode = (m: SearchMode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* private mode / storage disabled — mode still applies for the session */
    }
  };

  const rowKind = (h: SearchRow): HitKind => (isHybrid(h) ? h.kind : 'entity');
  const filtered = results?.filter((h) => kindFilter === 'all' || rowKind(h) === kindFilter) ?? [];
  const kindLabel = KIND_FILTERS.find((k) => k.kind === kindFilter)?.label ?? 'all';
  const filteredEmpty = results !== null && kindFilter !== 'all' && filtered.length === 0 && results.length > 0;

  return (
    <>
      <div className="view-header">
        <h1>Semantic Search</h1>
      </div>
      <p className="sub">Full-text + semantic search across the knowledge graph.</p>
      <input
        className="search-input"
        placeholder="Search entities…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void run(q)}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <div className="mode-toggle" role="group" aria-label="Search mode">
          {MODES.map((m) => {
            // lexical is never disabled (UI-SPEC §1.4); hybrid/semantic disable on explicit available:false.
            const disabled = semanticUnavailable && m !== 'lexical';
            return (
              <button
                key={m}
                className={mode === m ? 'on' : ''}
                aria-pressed={mode === m}
                disabled={disabled}
                title={disabled ? 'Semantic index unavailable — run deepindex embed --fetch-model' : undefined}
                onClick={() => changeMode(m)}
              >
                {m}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {KIND_FILTERS.map(({ label, kind }) => (
            <button
              key={kind}
              className={`kind-chip${kindFilter === kind ? ' on' : ''}`}
              aria-pressed={kindFilter === kind}
              onClick={() => setKindFilter(kind)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {results !== null && (
        <div className="search-meta">
          {/* R-W1: filtered count when a kind chip is active; filtered-empty names the kind. */}
          <span>
            {kindFilter !== 'all' && filtered.length === 0 ? (
              <>No {kindLabel} matches</>
            ) : (
              <>
                Found: <strong style={{ color: 'var(--text-dim)' }}>{filtered.length} nodes</strong>
              </>
            )}
          </span>
          <span>MODE: {mode.toUpperCase()}</span>
        </div>
      )}
      {semanticUnavailable && mode !== 'lexical' && (
        <div className="hint-card">
          Semantic index unavailable. Run <code>deepindex embed --fetch-model</code> to enable.
        </div>
      )}
      {loading && <div className="state"><h2>Searching…</h2></div>}
      {error && <div className="state"><h2>Could not load data</h2><p>{error}</p></div>}
      {results && results.length === 0 && <div className="state"><h2>No results</h2><p>Try a different query.</p></div>}
      {filteredEmpty && (
        <div className="state" style={{ padding: 24 }}>
          <p>No {kindLabel} results for this query.</p>
        </div>
      )}
      {filtered.map((h) =>
        isHybrid(h) ? (
          (() => {
            const isStatic = h.kind === 'module' || h.kind === 'doc';
            const activate = () => {
              if (h.kind === 'entity') onSelectEntity(h.id);
              else if (h.kind === 'symbol' || h.kind === 'file') onOpenSymbols(h.path ?? '');
            };
            const interactive = isStatic
              ? {}
              : {
                    onClick: activate,
                    onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        activate();
                      }
                    },
                    tabIndex: 0,
                    role: 'button',
                  } as const;
            return (
              <div key={`${h.kind}:${h.id}`} className={`result${isStatic ? ' result-static' : ''}`} {...interactive}>
                <div className="result-name">
                  <span className={`tag tag-${h.kind}`}>{h.kind}</span> {h.label}
                </div>
                {/* E-05: snippet → label fallback, never 'undefined'. E-18: doc/module clamp 4 lines. */}
                <div className={`result-content${isStatic ? ' clamp' : ''}`}>{h.snippet ?? h.label}</div>
                {/* E-06: missing path → no path label. */}
                {h.kind !== 'entity' && h.path && <div className="mono-label" style={{ marginBottom: 8 }}>{h.path}</div>}
                <div className="result-actions">
                  {h.kind === 'entity' && (
                    <button
                      className="btn btn-accent"
                      onClick={(e) => { e.stopPropagation(); onOpenInGraph(h.id); }}
                    >
                      <span className="material-symbols-outlined">account_tree</span> View in Graph
                    </button>
                  )}
                  <ScoreBadge hit={h} mode={mode} />
                </div>
              </div>
            );
          })()
        ) : (
          <div
            key={h.id}
            className="result"
            onClick={() => onSelectEntity(h.id)}
            tabIndex={0}
            role="button"
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectEntity(h.id);
              }
            }}
          >
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
        )
      )}
    </>
  );
}

/** Score badge — one helper keyed (mode, source). R-B2 + U-1 (checker F-2):
 *  hybrid mode → EVERY fused hit is RRF-scale (≤ 3/61 ≈ 0.049, never cosine)
 *  → `rrf {score.toFixed(3)}` unaccented regardless of source; semantic mode
 *  keys on source — 'vec' → `cos {score.toFixed(2)}` accented at ≥ 0.35,
 *  'lexical' fallback → `rank {score.toFixed(2)}` never accented; 'graph'
 *  → `rrf` never accented. Lexical mode never yields HybridHits (server
 *  returns the legacy shape verbatim) — legacy rows keep the existing
 *  `rank {n}` mono-label rendering. */
function ScoreBadge({ hit, mode }: { hit: HybridHit; mode: SearchMode }) {
  if (mode === 'hybrid' || hit.source === 'graph') {
    return <span className="score-badge">rrf {hit.score.toFixed(3)}</span>;
  }
  if (hit.source === 'vec') {
    const accented = hit.score >= 0.35;
    return <span className={`score-badge${accented ? ' on' : ''}`}>cos {hit.score.toFixed(2)}</span>;
  }
  return <span className="score-badge">rank {hit.score.toFixed(2)}</span>;
}