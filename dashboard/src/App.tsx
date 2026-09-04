import { useState, useEffect, lazy, Suspense } from 'react';
import DetailPanel, { type Selection, type CommitEntry } from './DetailPanel';
import { withProject } from './util';
// Lazy-loaded: keeps vis-network out of the initial bundle.
const Dashboard = lazy(() => import('./views/Dashboard'));
const KnowledgeGraph = lazy(() => import('./views/KnowledgeGraph'));
const Entities = lazy(() => import('./views/Entities'));
const Relations = lazy(() => import('./views/Relations'));
const Episodes = lazy(() => import('./views/Episodes'));
const Search = lazy(() => import('./views/Search'));
const DataFlow = lazy(() => import('./views/DataFlow'));
const Symbols = lazy(() => import('./views/Symbols'));

type View = 'dashboard' | 'knowledge' | 'entities' | 'relations' | 'episodes' | 'search' | 'dataflow' | 'symbols';

const NAV_MAIN: { id: View; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'space_dashboard' },
  { id: 'knowledge', label: 'Knowledge Graph', icon: 'account_tree' },
  { id: 'entities', label: 'Entities', icon: 'category' },
  { id: 'relations', label: 'Relations', icon: 'hub' },
  { id: 'episodes', label: 'Episodes', icon: 'history_edu' },
];
const NAV_MORE: { id: View; label: string; icon: string }[] = [
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'dataflow', label: 'Data Flow', icon: 'schema' },
  { id: 'symbols', label: 'Symbols', icon: 'data_object' },
];

interface Project { name: string; path: string; lastIndexed: string }
interface Overview { files: number; symbols: number; entities: number; backlinks: number; tables: number; commits: number }

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState('');
  const [selection, setSelection] = useState<Selection>(null);
  const [topQuery, setTopQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [overview, setOverview] = useState<Overview | null>(null);

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((d) => {
        setProjects(d.projects ?? []);
        if (d.projects?.length > 0) setProject(d.projects[0].name);
      })
      .catch(() => {});
  }, []);

  const qs = project ? `?project=${encodeURIComponent(project)}` : '';

  useEffect(() => {
    fetch(withProject('/api/overview', qs))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setOverview(d))
      .catch(() => {});
  }, [qs]);

  const selectEntity = (id: string) => setSelection({ kind: 'entity', id });
  const selectCommit = (commit: CommitEntry) => setSelection({ kind: 'commit', commit });
  const openInGraph = (id: string) => {
    setSelection({ kind: 'entity', id });
    setView('knowledge');
  };
  const submitSearch = () => {
    if (!topQuery.trim()) return;
    setSearchQuery(topQuery);
    setView('search');
  };

  return (
    <div>
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <span className="brand-dot" />
            <span className="brand-name">DeepIndex</span>
            <span className="brand-chip">0.1</span>
          </div>
          <div className="global-search">
            <span className="material-symbols-outlined" style={{ fontSize: 15, color: 'var(--text-faint)' }}>search</span>
            <input
              placeholder="Search entities, tags, knowledge…"
              value={topQuery}
              onChange={(e) => setTopQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitSearch()}
            />
            <span className="search-kbd">⏎</span>
          </div>
        </div>
        <div className="topbar-right">
          <button className="icon-btn" title="Refresh" onClick={() => setSelection(null)}>
            <span className="material-symbols-outlined">sync</span>
          </button>
          <span className="topbar-sep" />
          <button className="user-chip">
            <span className="avatar">D</span>
            <span className="mono-label" style={{ color: 'var(--text-dim)' }}>local</span>
          </button>
        </div>
      </header>

      <aside className="sidenav">
        <div className="sidenav-workspace">
          <span className="mono-label">Workspace</span>
          <h2 className="sidenav-title">{project || 'No project'}</h2>
        </div>
        <nav className="sidenav-nav">
          {NAV_MAIN.map((n) => (
            <button
              key={n.id}
              className={`sidenav-link ${view === n.id ? 'active' : ''}`}
              onClick={() => setView(n.id)}
            >
              <span className="material-symbols-outlined">{n.icon}</span> {n.label}
            </button>
          ))}
        </nav>
        <nav className="sidenav-nav nav-section">
          {NAV_MORE.map((n) => (
            <button
              key={n.id}
              className={`sidenav-link ${view === n.id ? 'active' : ''}`}
              onClick={() => setView(n.id)}
            >
              <span className="material-symbols-outlined">{n.icon}</span> {n.label}
            </button>
          ))}
        </nav>
        <div className="sidenav-footer">
          <div>
            <span className="scope-label">Project Scope</span>
            <select className="project-select" value={project} onChange={(e) => { setProject(e.target.value); setSelection(null); }}>
              {projects.length === 0 && <option value="">No projects</option>}
              {projects.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="sync-status">
            <span className="sync-dot" />
            <span>Index Synced</span>
          </div>
        </div>
      </aside>

      <main className={`main ${selection ? '' : 'without-panel'}`}>
        <div className="content">
          <Suspense fallback={<div className="state"><h2>Loading…</h2></div>}>
            {view === 'dashboard' && <Dashboard qs={qs} onSelectCommit={selectCommit} />}
            {view === 'knowledge' && <KnowledgeGraph qs={qs} onSelectEntity={selectEntity} />}
            {view === 'entities' && <Entities qs={qs} onSelectEntity={selectEntity} />}
            {view === 'relations' && <Relations qs={qs} onSelectEntity={selectEntity} />}
            {view === 'episodes' && <Episodes qs={qs} activeSha={selection?.kind === 'commit' ? selection.commit.sha : null} onSelectCommit={selectCommit} />}
            {view === 'search' && <Search qs={qs} initialQuery={searchQuery} onSelectEntity={selectEntity} onOpenInGraph={openInGraph} />}
            {view === 'dataflow' && <DataFlow qs={qs} />}
            {view === 'symbols' && <Symbols qs={qs} />}
          </Suspense>
        </div>
      </main>

      {selection && (
        <DetailPanel
          selection={selection}
          qs={qs}
          onClose={() => setSelection(null)}
          onSelectEntity={selectEntity}
          onOpenInGraph={openInGraph}
        />
      )}

      <footer className="footer">
        <div className="footer-left">
          <span className="footer-core">DEEPINDEX_CORE</span>
          <span className="footer-count">ENTITIES: <strong>{overview?.entities ?? '—'}</strong></span>
          <span className="footer-count">EDGES: <strong>{overview?.backlinks ?? '—'}</strong></span>
          <span className="footer-count">EPISODES: <strong>{overview?.commits ?? '—'}</strong></span>
        </div>
        <div className="footer-right">
          <span className="footer-status">
            <span className="sync-dot" /> Read-only
          </span>
        </div>
      </footer>
    </div>
  );
}