import { useState } from 'react';
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

export default function App() {
  const [view, setView] = useState<View>('overview');
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
      </nav>
      <main className="content">
        {view === 'overview' && <Overview />}
        {view === 'knowledge' && <KnowledgeGraph />}
        {view === 'dataflow' && <DataFlow />}
        {view === 'search' && <Search />}
        {view === 'symbols' && <Symbols />}
      </main>
    </div>
  );
}
