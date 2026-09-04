import { useApi, State } from '../useApi';
import { withProject, timeAgo } from '../util';
import type { CommitEntry } from '../DetailPanel';

interface Props {
  qs: string;
  activeSha: string | null;
  onSelectCommit(c: CommitEntry): void;
}

export default function Episodes({ qs, activeSha, onSelectCommit }: Props) {
  const { data, loading, error } = useApi<{ commits: CommitEntry[] }>(withProject('/api/commits?limit=50', qs));
  return (
    <State loading={loading} error={error}>
      <div className="view-header">
        <h1>Episodes</h1>
      </div>
      <p className="sub">Chronological intelligence stream — the commit history your knowledge graph was extracted from.</p>
      {data && data.commits.length === 0 ? (
        <div className="state"><h2>No episodes indexed</h2><p>Run <code>deepindex index &lt;repo&gt;</code> to extract commits.</p></div>
      ) : (
        <div className="timeline">
          {data?.commits.map((c) => (
            <div
              key={c.sha}
              className={`tl-row ${activeSha === c.sha ? 'selected' : ''}`}
              onClick={() => onSelectCommit(c)}
            >
              <span className={`tl-dot ${c.commit_type}`} title={c.commit_type} />
              <div className="tl-main">
                <p className="tl-title">{c.message}</p>
                <div className="tl-sub">
                  {c.entityCount > 0 && <span className="tl-tag">+{c.entityCount} entities</span>}
                  <span>{c.author}</span>
                  <span>{c.sha.slice(0, 8)}</span>
                </div>
              </div>
              <span className="tl-time">{timeAgo(c.author_date)}</span>
            </div>
          ))}
        </div>
      )}
    </State>
  );
}