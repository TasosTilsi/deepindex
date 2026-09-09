import { useApi, State } from '../useApi';
import { withProject, timeAgo } from '../util';
import type { CommitEntry } from '../DetailPanel';
import type { ReactNode } from 'react';

interface Overview {
  files: number;
  symbols: number;
  entities: number;
  backlinks: number;
  tables: number;
  commits: number;
  entityTypes: { type: string; c: number }[];
}
interface Health {
  score: number;
  dimensions: { freshness: number; consistency: number; coverage: number; confidence: number };
  issues: unknown[];
}
interface Activity { activity: { week: string; entities: number; commits: number }[] }
interface Commits { commits: CommitEntry[] }

const TYPE_PALETTE = ['#1f6c9f', '#346538', '#956400', '#9f2f2d', '#787774'];
const pct = (n: number) => `${Math.round(n * 100)}%`;

export default function Dashboard({ qs, onSelectCommit }: { qs: string; onSelectCommit(c: CommitEntry): void }) {
  const overview = useApi<Overview>(withProject('/api/overview', qs));
  const health = useApi<Health>(withProject('/api/health', qs));
  const activity = useApi<Activity>(withProject('/api/activity?weeks=12', qs));
  const commits = useApi<Commits>(withProject('/api/commits?limit=50', qs));

  return (
    <State loading={overview.loading} error={overview.error}>
      {overview.data && (
        <>
          <div className="view-header">
            <h1>Neural Nexus</h1>
          </div>

          {/* Row 1: stat cards */}
          <div className="grid grid-3">
            <div className="card">
              <div className="card-title">
                <div>
                  <p className="stat-label">Indexed Entities</p>
                  <h3 className="stat-value">{overview.data.entities.toLocaleString()}</h3>
                </div>
                <div className="stat-icon"><span className="material-symbols-outlined">fingerprint</span></div>
              </div>
              <div className="stat-foot">
                <span className="up">
                  <span className="material-symbols-outlined" style={{ fontSize: 12 }}>arrow_upward</span>
                  +{activity.data?.activity.at(-1)?.entities ?? 0} new
                </span>
                <span>this week</span>
              </div>
              <div className="progress"><div style={{ width: pct(Math.min(1, overview.data.entities / 1000)) }} /></div>
            </div>

            <div className="card">
              <div className="card-title">
                <div>
                  <p className="stat-label">Active Edges</p>
                  <h3 className="stat-value">{overview.data.backlinks.toLocaleString()}</h3>
                </div>
                <div className="stat-icon"><span className="material-symbols-outlined">share</span></div>
              </div>
              <div className="stat-foot">
                <span>Semantic Density</span>
                <span>
                  {overview.data.entities > 0
                    ? (overview.data.backlinks / overview.data.entities).toFixed(2)
                    : '0.00'}{' '}
                  avg
                </span>
              </div>
              <div className="progress"><div style={{ width: pct(Math.min(1, (overview.data.backlinks / Math.max(1, overview.data.entities)) / 8)) }} /></div>
            </div>

            <div className="card">
              <div className="card-title">
                <div>
                  <p className="stat-label">Total Episodes</p>
                  <h3 className="stat-value">{overview.data.commits.toLocaleString()}</h3>
                </div>
                <div className="stat-icon"><span className="material-symbols-outlined">database</span></div>
              </div>
              <div className="stat-foot">
                <span className="ok"><span className="sync-dot" /> {health.data ? (health.data.score >= 80 ? 'Optimal' : 'Degraded') : '…'}</span>
                <span>{overview.data.files.toLocaleString()} files</span>
              </div>
              <div className="progress"><div style={{ width: pct(health.data ? health.data.score / 100 : 0.5) }} /></div>
            </div>

            {/* Semantic Index (DASH-02, UI-SPEC §2.1 + R-W5/R-W8) — 4th card wraps to its
                own row in grid-3 (U-2 accepted). Read-only: no buttons, no writes (D-28c). */}
            <SemanticCard qs={qs} />
          </div>

          {/* Row 2: nexus activity + velocity */}
          <div className="grid grid-5-2">
            <div className="card" style={{ minHeight: 340, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
              <div className="card-title" style={{ marginBottom: 0 }}>
                <div>
                  <h2><span className="dot" /> Nexus Activity</h2>
                  <p className="card-sub">Recent knowledge-graph firing fragment</p>
                </div>
                <span className="chip">SNAPSHOT</span>
              </div>
              <div className="nexus-canvas">
                <svg height="260" viewBox="0 0 400 300" width="380" className="chart-svg">
                  <circle cx="200" cy="150" fill="#1f6c9f" r="3.5" />
                  <circle cx="120" cy="80" fill="#787774" r="2.5" />
                  <circle cx="280" cy="100" fill="#956400" r="3" />
                  <circle cx="150" cy="220" fill="#787774" r="2.5" />
                  <circle cx="250" cy="240" fill="#1f6c9f" r="3" />
                  <line opacity="0.25" stroke="#1f6c9f" strokeWidth="1" x1="200" x2="120" y1="150" y2="80" />
                  <line opacity="0.25" stroke="#1f6c9f" strokeWidth="1" x1="200" x2="280" y1="150" y2="100" />
                  <line opacity="0.2" stroke="#787774" strokeWidth="1" x1="200" x2="150" y1="150" y2="220" />
                  <line opacity="0.25" stroke="#1f6c9f" strokeWidth="1" x1="200" x2="250" y1="150" y2="240" />
                  <line opacity="0.15" stroke="#787774" strokeWidth="1" x1="120" x2="280" y1="80" y2="100" />
                </svg>
              </div>
              <div className="nexus-stats">
                <div>
                  <span className="mono-label">Files</span>
                  {overview.data.files.toLocaleString()}
                </div>
                <div>
                  <span className="mono-label">Symbols</span>
                  {overview.data.symbols.toLocaleString()}
                </div>
                <div>
                  <span className="mono-label">Tables</span>
                  {overview.data.tables.toLocaleString()}
                </div>
                <div>
                  <span className="mono-label">Entity Types</span>
                  {overview.data.entityTypes.length}
                </div>
              </div>
            </div>

            <div className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
              <div className="card-title" style={{ marginBottom: 0 }}>
                <div>
                  <h2>Intelligence Velocity</h2>
                  <p className="card-sub">Weekly knowledge accumulation</p>
                </div>
                <span className="chip">12W</span>
              </div>
              <VelocityBars activity={activity.data?.activity ?? []} />
              <div className="stat-foot" style={{ borderTop: '1px solid var(--line)', paddingTop: 14, margin: 0 }}>
                <div>
                  <span className="mono-label" style={{ display: 'block' }}>Growth Rate</span>
                  <span className="stat-value" style={{ fontSize: 18 }}>
                    {growthRate(activity.data?.activity)}
                  </span>
                </div>
                <div>
                  <span className="mono-label" style={{ display: 'block' }}>Entity Delta</span>
                  <span className="stat-value" style={{ fontSize: 18 }}>
                    +{(activity.data?.activity.at(-1)?.entities ?? 0)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Row 3: growth chart + recent activity */}
          <div className="grid grid-3-1">
            <div className="card">
              <div className="card-title">
                <div>
                  <h2>Knowledge Growth</h2>
                  <p className="card-sub">Trend across index schemas</p>
                </div>
                <div className="legend-row">
                  <span className="legend-item"><span className="swatch" style={{ background: '#111111' }} /> Structural</span>
                  <span className="legend-item"><span className="swatch" style={{ background: '#787774' }} /> Semantic</span>
                </div>
              </div>
              <GrowthChart activity={activity.data?.activity ?? []} />
            </div>
            <div className="card">
              <div className="card-title">
                <h2>Recent Activity</h2>
                <span className="mono-label">Stream</span>
              </div>
              <div className="timeline">
                {(commits.data?.commits ?? []).slice(0, 6).map((c) => (
                  <div key={c.sha} className="tl-row" onClick={() => onSelectCommit(c)} style={{ padding: '8px 6px' }}>
                    <span className={`tl-dot ${c.commit_type}`} />
                    <div className="tl-main">
                      <p className="tl-title">{c.message}</p>
                      {c.entityCount > 0 && <div className="tl-sub"><span className="tl-tag">+{c.entityCount} entities</span></div>}
                    </div>
                    <span className="tl-time">{timeAgo(c.author_date)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Row 4: sources + health */}
          <div className="grid grid-2">
            <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
              <SourcesDonut entityTypes={overview.data.entityTypes} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {overview.data.entityTypes.slice(0, 5).map((t, i) => (
                  <div key={t.type} style={{ display: 'flex', justifyContent: 'space-between' }} className="mono-label">
                    <span style={{ color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="swatch" style={{ width: 8, height: 8, borderRadius: '50%', background: TYPE_PALETTE[i % TYPE_PALETTE.length], display: 'inline-block' }} />
                      {t.type.replace('_', ' ')}
                    </span>
                    <span>{overview.data.entities > 0 ? Math.round((t.c / overview.data.entities) * 100) : 0}%</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="card-title">
                <h2>Index Health</h2>
                <span className="tag tag-decision">{health.data ? (health.data.score >= 80 ? 'Optimal' : 'Needs Repair') : '…'}</span>
              </div>
              {health.data && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <HealthBar label="Relational Integrity" value={health.data.dimensions.consistency} />
                  <HealthBar label="Semantic Cohesion" value={health.data.dimensions.coverage} />
                  <HealthBar label="Temporal Drift" value={1 - health.data.dimensions.freshness} drift />
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </State>
  );
}

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

/** Overview "Semantic Index" card (UI-SPEC §2 + R-W5/R-W8). Mount-driven
 *  useApi — refetch on project switch, no polling. States matrix §2.2:
 *  E-10 (fetch error contained — never trips the outer <State> gate, which
 *  checks only `overview`), E-11 (coverage clamp 0..1), E-12 (invalid
 *  lastEmbedAt → '—'). No buttons, no click handlers (D-28c guardrail). */
function SemanticCard({ qs }: { qs: string }) {
  const status = useApi<EmbedStatus>(withProject('/api/embed-status', qs));
  const d = status.data;
  // E-11: missing/NaN coverage → 0; clamp to [0, 1] before rendering.
  const coverage =
    d && typeof d.coverage === 'number' && Number.isFinite(d.coverage)
      ? Math.min(1, Math.max(0, d.coverage))
      : 0;

  let statValue = '—';
  let subLine = '—';
  let progress = 0;
  let footLeft: ReactNode = '—';
  let footRight: ReactNode = '—';

  if (status.loading) {
    statValue = '…';
  } else if (status.error) {
    subLine = 'status unavailable';
  } else if (d && d.available === false) {
    subLine = 'not available';
    footLeft = (
      <span>
        hint: <code>deepindex embed --fetch-model</code>
      </span>
    );
  } else if (d) {
    if (coverage > 0) {
      statValue = `${Math.round(coverage * 100)}%`;
      subLine = d.model ? `${d.model} · ${d.dim}d` : '—';
      progress = coverage;
      // R-W5: '{n} stale' only when present and > 0; absent + coverage 1 → 'up to date';
      // absent + coverage < 1 → omit stale text. Never '0 stale'.
      footLeft =
        d.staleCount !== undefined && d.staleCount > 0
          ? `${d.staleCount} stale`
          : coverage >= 1
            ? 'up to date'
            : '';
    } else {
      statValue = '0%';
      subLine = 'not embedded';
      footLeft = 'run deepindex embed';
    }
    // E-12: timeAgo returns '' for absent/invalid ISO → '—'.
    footRight = d.lastEmbedAt ? timeAgo(d.lastEmbedAt) || '—' : '—';
  }

  return (
    <div className="card">
      <div className="card-title">
        <div>
          <p className="stat-label">Semantic Index</p>
          <h3 className="stat-value">{statValue}</h3>
        </div>
        <div className="stat-icon"><span className="material-symbols-outlined">blur_on</span></div>
      </div>
      <p className="mono-label" style={{ marginBottom: 8 }}>{subLine}</p>
      <div className="progress"><div style={{ width: pct(progress) }} /></div>
      <div className="stat-foot">
        <span>{footLeft}</span>
        <span>{footRight}</span>
      </div>
    </div>
  );
}

function HealthBar({ label, value, drift }: { label: string; value: number; drift?: boolean }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }} className="mono-label">
        <span style={{ color: 'var(--text-dim)' }}>{label}</span>
        <span style={{ color: 'var(--text-dim)' }}>{pct(value)}</span>
      </div>
      <div className="progress"><div style={{ width: pct(value), background: drift ? '#c8c7c3' : undefined }} /></div>
    </div>
  );
}

function VelocityBars({ activity }: { activity: { week: string; entities: number }[] }) {
  const weeks = activity.slice(-8);
  const max = Math.max(1, ...weeks.map((w) => w.entities));
  return (
    <div className="bars" style={{ margin: '16px 0' }}>
      {weeks.map((w, i) => (
        <div key={w.week} className={i === weeks.length - 1 ? 'last' : ''} style={{ height: `${Math.max(4, (w.entities / max) * 100)}%` }} title={`${w.week}: ${w.entities} entities`} />
      ))}
    </div>
  );
}

function growthRate(activity?: { week: string; entities: number }[]): string {
  if (!activity || activity.length < 2) return '—';
  const prev = activity[activity.length - 2]?.entities ?? 0;
  const last = activity[activity.length - 1]?.entities ?? 0;
  if (prev === 0) return last > 0 ? 'NEW' : '0%';
  return `${last >= prev ? '+' : ''}${Math.round(((last - prev) / prev) * 100)}%`;
}

function GrowthChart({ activity }: { activity: { week: string; entities: number; commits: number }[] }) {
  if (activity.length < 2) return <div className="state" style={{ padding: 30 }}><p>Not enough history yet.</p></div>;
  const W = 400;
  const H = 100;
  const max = Math.max(1, ...activity.map((w) => Math.max(w.entities, w.commits)));
  const x = (i: number) => (i / (activity.length - 1)) * W;
  const y = (v: number) => H - (v / max) * (H - 8) - 4;
  const line = (key: 'entities' | 'commits') => activity.map((w, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(w[key]).toFixed(1)}`).join(' ');
  return (
    <div style={{ height: 220 }}>
      <svg className="chart-svg" preserveAspectRatio="none" viewBox={`0 0 ${W} ${H}`}>
        {[25, 55, 85].map((yy) => (
          <line key={yy} className="chart-grid-line" x1="0" x2={W} y1={yy} y2={yy} />
        ))}
        <path d={line('commits')} fill="none" stroke="#111111" strokeWidth="1.75" />
        <path d={line('entities')} fill="none" stroke="#787774" strokeDasharray="3,3" strokeWidth="1.75" />
      </svg>
    </div>
  );
}

function SourcesDonut({ entityTypes }: { entityTypes: { type: string; c: number }[] }) {
  const total = entityTypes.reduce((a, t) => a + t.c, 0) || 1;
  let offset = 25;
  return (
    <div style={{ position: 'relative', width: 112, height: 112, flexShrink: 0 }}>
      <svg className="chart-svg" viewBox="0 0 36 36">
        <circle cx="18" cy="18" fill="transparent" r="15.9" stroke="rgba(17,17,17,0.08)" strokeWidth="2.5" />
        {entityTypes.map((t, i) => {
          const share = (t.c / total) * 100;
          const dash = `${share} ${100 - share}`;
          const el = (
            <circle
              key={t.type}
              cx="18"
              cy="18"
              fill="transparent"
              r="15.9"
              stroke={TYPE_PALETTE[i % TYPE_PALETTE.length]}
              strokeDasharray={dash}
              strokeDashoffset={offset}
              strokeWidth="2.5"
            />
          );
          offset -= share;
          return el;
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <span className="mono-label" style={{ fontSize: 8 }}>ENTITIES</span>
        <span className="mono-label" style={{ fontSize: 8 }}>DISTRIB</span>
      </div>
    </div>
  );
}