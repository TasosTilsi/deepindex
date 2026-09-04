import { useState, useEffect } from 'react';
import Overview from './views/Overview';
import KnowledgeGraph from './views/KnowledgeGraph';
import DataFlow from './views/DataFlow';
import Search from './views/Search';
import Symbols from './views/Symbols';

type View = 'overview' | 'knowledge' | 'dataflow' | 'search' | 'symbols';

const NAV: { id: View; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'knowledge', label: 'Knowledge Graph' },
  { id: 'dataflow', label: 'Data Flow' },
  { id: 'search', label: 'Search' },
  { id: 'symbols', label: 'Symbols' },
];

interface Project { name: string; path: string; lastIndexed: string; }

export default function App() {
  const [view, setView] = useState<View>('overview');
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<string>('');

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

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-brand">DeepIndex</div>
        <div className="nav-links">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`nav-link ${view === n.id ? 'active' : ''}`}
              onClick={() => setView(n.id)}
            >
              {n.label}
            </button>
          ))}
        </div>
        <select className="project-select" value={project} onChange={(e) => setProject(e.target.value)}>
          {projects.length === 0 && <option value="">No projects</option>}
          {projects.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
      </nav>
      <main className="content">
        {view === 'overview' && <Overview qs={qs} />}
        {view === 'knowledge' && <KnowledgeGraph qs={qs} />}
        {view === 'dataflow' && <DataFlow qs={qs} />}
        {view === 'search' && <Search qs={qs} />}
        {view === 'symbols' && <Symbols qs={qs} />}
      </main>
    </div>
  );
}
