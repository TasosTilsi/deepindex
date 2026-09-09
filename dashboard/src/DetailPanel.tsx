import { useApi } from './useApi';
import { withProject, timeAgo } from './util';

/** What is shown in the right detail panel. Entity selections carry just an
 *  id (detail fetched via /api/entity); commit selections embed the row the
 *  Episodes view already loaded. */
export type Selection =
  | { kind: 'entity'; id: string }
  | { kind: 'commit'; commit: CommitEntry }
  | null;

export interface CommitEntity {
  id: string;
  name: string;
  type: string;
}

export interface CommitEntry {
  sha: string;
  message: string;
  author: string;
  author_date: string;
  insertions: number;
  deletions: number;
  commit_type: string;
  entityCount: number;
  entities: CommitEntity[];
}

interface EntityDetail {
  entity: {
    id: string;
    type: string;
    name: string;
    content: string;
    tags: string[];
    created_at: string;
    last_seen: string;
    commit_sha: string | null;
  };
  commit: { sha: string; message: string; author: string; author_date: string } | null;
  related: { id: string; type: string; name: string; relationship: string; context: string }[];
}

interface Props {
  selection: Selection;
  qs: string;
  onClose(): void;
  onSelectEntity(id: string): void;
  onOpenInGraph(id: string): void;
}

export default function DetailPanel(props: Props) {
  const { selection } = props;
  if (!selection) return null;
  if (selection.kind === 'entity') return <EntityPanel {...props} id={selection.id} />;
  return <CommitPanel {...props} commit={selection.commit} />;
}

function PanelFrame({ chip, title, meta, onClose, children, actions }: {
  chip: string;
  title: string;
  meta: string;
  onClose(): void;
  children: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <div className="detail-head-row">
          <span className="detail-chip">{chip}</span>
          <button className="icon-btn" onClick={onClose} title="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <h1 className="detail-title">{title}</h1>
        <div className="detail-meta">{meta}</div>
      </div>
      <div className="detail-body">
        {children}
        <div className="detail-actions">{actions}</div>
      </div>
    </aside>
  );
}

function EntityPanel({ id, qs, onClose, onSelectEntity, onOpenInGraph }: Props & { id: string }) {
  const { data, loading, error } = useApi<EntityDetail>(withProject(`/api/entity?id=${encodeURIComponent(id)}`, qs));
  if (loading) return <aside className="detail-panel"><div className="state"><h2>Loading…</h2></div></aside>;
  if (error || !data) return <aside className="detail-panel"><div className="state"><h2>Could not load entity</h2><p>{error}</p></div></aside>;
  const e = data.entity;
  return (
    <PanelFrame
      chip={e.type.replace('_', ' ')}
      title={e.name}
      meta={`${e.id} · ${timeAgo(e.created_at)}`}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-accent" onClick={() => onOpenInGraph(e.id)}>
            <span className="material-symbols-outlined">account_tree</span> Open Graph
          </button>
          <button className="btn" onClick={onClose}>Close</button>
        </>
      }
    >
      <section>
        <h3 className="detail-section-title">Content</h3>
        <div className="detail-content">{e.content}</div>
      </section>
      {e.tags.length > 0 && (
        <section>
          <h3 className="detail-section-title">Metadata Tags</h3>
          <div className="chips">{e.tags.map((t) => <span key={t} className="chip">#{t}</span>)}</div>
        </section>
      )}
      {data.commit && (
        <section>
          <h3 className="detail-section-title">Source Episode</h3>
          <div className="related-row" onClick={() => undefined}>
            <span className="related-name">
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>commit</span>
              <span className="name-text">{data.commit.message}</span>
            </span>
            <span className="related-rel">{timeAgo(data.commit.author_date)}</span>
          </div>
        </section>
      )}
      <section>
        <h3 className="detail-section-title">Inferred Relations</h3>
        {data.related.length === 0 ? (
          <p className="detail-meta">No relations.</p>
        ) : (
          data.related.map((r) => (
            <div key={`${r.id}-${r.relationship}`} className="related-row" onClick={() => onSelectEntity(r.id)}>
              <span className="related-name">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>link</span>
                <span className="name-text">{r.name}</span>
              </span>
              <span className="related-rel">{r.relationship.replace('inverse:', '')}</span>
            </div>
          ))
        )}
      </section>
    </PanelFrame>
  );
}

function CommitPanel({ commit, onClose, onSelectEntity }: Props & { commit: CommitEntry }) {
  const c = commit;
  return (
    <PanelFrame
      chip="episode"
      title={c.message}
      meta={`${c.sha.slice(0, 8)} · ${c.author} · ${timeAgo(c.author_date)}`}
      onClose={onClose}
      actions={<button className="btn" onClick={onClose}>Close</button>}
    >
      <section>
        <h3 className="detail-section-title">Changes</h3>
        <div className="chips">
          <span className="chip">+{c.insertions}</span>
          <span className="chip">−{c.deletions}</span>
          <span className="chip">{c.commit_type}</span>
        </div>
      </section>
      <section>
        <h3 className="detail-section-title">Extracted Entities</h3>
        {c.entities.length === 0 ? (
          <p className="detail-meta">No entities extracted.</p>
        ) : (
          c.entities.map((e) => (
            <div key={e.id} className="related-row" onClick={() => onSelectEntity(e.id)}>
              <span className="related-name">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>category</span>
                <span className="name-text">{e.name}</span>
              </span>
              <span className="related-rel">{e.type.replace('_', ' ')}</span>
            </div>
          ))
        )}
        {c.entityCount > c.entities.length && (
          <p className="detail-meta">+{c.entityCount - c.entities.length} more</p>
        )}
      </section>
    </PanelFrame>
  );
}