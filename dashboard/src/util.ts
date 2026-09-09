/** Shared frontend helpers. */

/** Merge the project query suffix (`?project=x` or '') into a path without
 *  producing a double-`?` or double-`&` — the bug class that used to 500 the
 *  Symbols view. */
export function withProject(path: string, qs: string): string {
  if (!qs) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${qs.slice(1)}`;
}

/** "2m ago" / "3h ago" / "4d ago" style relative time. */
export function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `${Math.floor(d)}d ago`;
  return new Date(t).toLocaleDateString();
}