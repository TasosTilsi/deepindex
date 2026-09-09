import { useApi, State } from '../useApi';
import { withProject } from '../util';

interface Relation {
  from_id: string;
  to_id: string;
  relationship: string;
  context: string;
  from_name: string;
  from_type: string;
  to_name: string;
  to_type: string;
}

export default function Relations({ qs, onSelectEntity }: { qs: string; onSelectEntity(id: string): void }) {
  const { data, loading, error } = useApi<Relation[]>(withProject('/api/relations?limit=100', qs));
  return (
    <State loading={loading} error={error}>
      <div className="view-header">
        <h1>Relations</h1>
      </div>
      <p className="sub">Edges between entities — inferred relationships across the knowledge graph.</p>
      {data && data.length === 0 ? (
        <div className="state"><h2>No relations</h2><p>Index a repo with git history to extract backlinks.</p></div>
      ) : (
        <>
          <div className="search-meta"><span>Found: {data?.length ?? 0} edges</span></div>
          {data?.map((r) => (
            <div key={`${r.from_id}-${r.to_id}-${r.relationship}`} className="rel-row" onClick={() => onSelectEntity(r.from_id)}>
              <span className="rel-name" style={{ flexShrink: 0 }}>{r.from_name}</span>
              <span className="rel-arrow material-symbols-outlined">arrow_forward</span>
              <span className="rel-rel">{r.relationship.replace('inverse:', '')}</span>
              <span className="rel-arrow material-symbols-outlined">arrow_forward</span>
              <span className="rel-name" style={{ flexShrink: 0 }}>{r.to_name}</span>
              <span className="rel-context">{r.context}</span>
            </div>
          ))}
        </>
      )}
    </State>
  );
}