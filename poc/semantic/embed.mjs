// POC (poc/semantic-search branch): explicit-fetch embedding of entities + symbols
// into vec0 tables in the project .deepindex.db. Hash-guarded, budget-printed.
// Deps resolved from bench-tmp/node_modules until deps are promoted properly.
// NOT production code — evaluation only.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '/home/tasostilsi/Development/Projects/context-engineering-framework';
const req = createRequire(join(REPO, 'bench-tmp', 'package.json'));
const Database = req('better-sqlite3');
const sqliteVec = req('sqlite-vec');
const transformersPath = req.resolve('@huggingface/transformers');
const { pipeline, env } = await import(pathToFileURL(transformersPath).href);

env.cacheDir = join(REPO, 'bench-tmp', 'models'); // POC cache; prod = ~/.deepindex/models
env.allowLocalModels = false;

const MODEL = 'Xenova/all-MiniLM-l6-v2';
const DIM = 384;
const args = new Set(process.argv.slice(2));
const dbPath = join(REPO, '.deepindex.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
sqliteVec.load(db);

// POC schema (candidate for schema v6 in phase 8). NOTE: sqlite-vec 0.1.9 + better-sqlite3
// cannot insert into declared-PK vec0 columns (xUpdate quirk) — use auto-rowid vec tables
// + own doc→rowid mapping. Prod phase should re-test with newer sqlite-vec.
db.exec(`CREATE TABLE IF NOT EXISTS poc_embed_meta(doc_id TEXT PRIMARY KEY, kind TEXT, hash TEXT, model TEXT, vec_rowid INTEGER)`);
const hasVec = (t) => !!db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(t);
if (!hasVec('entity_vecs')) db.exec(`CREATE VIRTUAL TABLE entity_vecs USING vec0(embedding float[${DIM}]);`);
if (!hasVec('symbol_vecs')) db.exec(`CREATE VIRTUAL TABLE symbol_vecs USING vec0(embedding float[${DIM}]);`);
if (!hasVec('doc_vecs')) db.exec(`CREATE VIRTUAL TABLE doc_vecs USING vec0(embedding float[${DIM}]);`);

// --- explicit fetch gate: refuse unless model cached OR --fetch-model given ---
const modelDir = join(env.cacheDir, MODEL); // transformers.js cache layout: <cache>/<org>/<name>
const cached = existsSync(modelDir);
if (!cached && !args.has('--fetch-model')) {
  console.error(`model not cached at ${env.cacheDir}. Re-run with --fetch-model (one-time explicit download, ~24MB).`);
  process.exit(2);
}

console.log('loading embedder...');
const t0 = Date.now();
const extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
console.log(`model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const ents = db.prepare('SELECT id, name, content, type FROM entities').all();
const syms = db.prepare(
  "SELECT s.id, s.name, s.kind, f.path, s.start_line, s.end_line FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.kind IN ('function','class','method','interface','type')"
).all();
const entText = (e) => `${e.type} | ${e.name.replace(/-/g, ' ')} | ${e.content}`;
const symText = (s) => `${s.kind} ${s.name} (in ${s.path})${s.docstring ? `\n${s.docstring}` : ''}`;

// --- A: docstrings via line-scan (prod phase: capture comments in parse.ts properly) ---
import { readFileSync } from 'node:fs';
const fileText = new Map(); // path -> lines
const linesOf = (p) => {
  if (!fileText.has(p)) {
    try { fileText.set(p, readFileSync(join(REPO, p), 'utf8').split('\n')); } catch { fileText.set(p, []); }
  }
  return fileText.get(p);
};
const isComment = (l) => /^\s*(\/\/|\/\*|\*|\/\/\/|#\s|#$)/.test(l) || /^\s*\*\/\s*$/.test(l);
function docstringFor(path, startLine) {
  const lines = linesOf(path);
  const out = [];
  for (let i = startLine - 2; i >= 0 && lines.length; i--) { // startLine is 1-based
    const l = lines[i] ?? '';
    if (l.trim() === '' && out.length === 0) continue; // one blank allowed
    if (!isComment(l)) break;
    out.unshift(l.trim());
    if (out.length >= 12) break;
  }
  return out.join(' ').replace(/^\/\*+|\*\/$|^\/\/|^#+/g, '').replace(/^\*+/, '').trim().slice(0, 400);
}
for (const s of syms) s.docstring = docstringFor(s.path, s.start_line);
const withDoc = syms.filter((s) => s.docstring).length;
console.log(`docstrings attached: ${withDoc}/${syms.length} symbols`);

// --- C: module cards — synthesized from existing graph rows (pure SQL) ---
const exportsOf = db.prepare('SELECT name, kind FROM symbols WHERE file_id = ? AND exported = 1 ORDER BY name LIMIT 12');
const importsOut = db.prepare('SELECT DISTINCT source FROM imports WHERE file_id = ? LIMIT 10');
const importedBy = db.prepare(
  'SELECT DISTINCT f.path FROM imports i JOIN files f ON f.id = i.file_id WHERE i.resolved_file_id = ? LIMIT 10'
);
const tablesOf = db.prepare(
  'SELECT DISTINCT qt.table_name FROM query_tables qt JOIN sql_queries q ON q.id = qt.query_id WHERE q.file_id = ? LIMIT 8'
);
const codeFiles = db.prepare(
  "SELECT id, path FROM files WHERE (path LIKE '%.ts' OR path LIKE '%.js' OR path LIKE '%.py') AND path NOT LIKE '%node_modules%' AND path NOT LIKE 'dashboard/%'"
).all();
function moduleCard(f) {
  const exp = exportsOf.all(f.id);
  if (!exp.length) return null;
  const imp = importsOut.all(f.id).map((r) => r.source);
  const by = importedBy.all(f.id).map((r) => r.path);
  const tabs = tablesOf.all(f.id).map((r) => r.table_name);
  const parts = [`module ${f.path} exports ${exp.map((e) => `${e.kind} ${e.name}`).join(', ')}.`];
  if (imp.length) parts.push(`depends on: ${imp.join(', ')}.`);
  if (by.length) parts.push(`imported by: ${by.join(', ')}.`);
  if (tabs.length) parts.push(`touches tables: ${tabs.join(', ')}.`);
  return parts.join(' ');
}

// --- B: markdown chunks — heading-split (tree-sitter markdown not needed for POC) ---
const mdFiles = db.prepare("SELECT path FROM files WHERE path LIKE '%.md' AND path NOT LIKE '%node_modules%' AND path NOT LIKE '.planning%'").all();
function mdChunks(path) {
  let text;
  try { text = readFileSync(join(REPO, path), 'utf8'); } catch { return []; }
  const out = [];
  let cur = null, body = [];
  const flush = () => {
    if (cur) {
      const t = `${cur}\n${body.join(' ')}`.replace(/\s+/g, ' ').trim();
      if (t.length > 60) out.push(t.slice(0, 700));
    }
  };
  for (const line of text.split('\n')) {
    if (/^#{1,3}\s/.test(line)) { flush(); cur = line.replace(/^#+\s*/, ''); body = []; }
    else if (cur) body.push(line);
  }
  flush();
  return out.map((t) => `${path} — ${t}`);
}

const insVecE = db.prepare('INSERT INTO entity_vecs(embedding) VALUES (?)');
const insVecS = db.prepare('INSERT INTO symbol_vecs(embedding) VALUES (?)');
const insVecD = db.prepare('INSERT INTO doc_vecs(embedding) VALUES (?)');
const delVecE = db.prepare('DELETE FROM entity_vecs WHERE rowid = ?');
const delVecS = db.prepare('DELETE FROM symbol_vecs WHERE rowid = ?');
const delVecD = db.prepare('DELETE FROM doc_vecs WHERE rowid = ?');
const meta = db.prepare('INSERT OR REPLACE INTO poc_embed_meta(doc_id, kind, hash, model, vec_rowid) VALUES (?, ?, ?, ?, ?)');
const getMeta = db.prepare('SELECT hash, vec_rowid FROM poc_embed_meta WHERE doc_id = ?');

// corpus: entities + symbols (with docstrings) + module cards + markdown chunks
const moduleCards = codeFiles.map((f) => ({ path: f.path, text: moduleCard(f) })).filter((m) => m.text);
const docTexts = mdFiles.flatMap((f) => mdChunks(f.path).map((t, i) => ({ id: `doc:${f.path}:${i}`, text: t })));
console.log(`module cards: ${moduleCards.length}, markdown chunks: ${docTexts.length}`);

let embedded = 0, skipped = 0;
const docs = [
  ...ents.map((e) => ({ kind: 'entity', id: e.id, text: entText(e), ins: insVecE, del: delVecE })),
  ...syms.map((s) => ({ kind: 'symbol', id: String(s.id), text: symText(s), ins: insVecS, del: delVecS })),
  ...moduleCards.map((m) => ({ kind: 'module', id: `module:${m.path}`, text: m.text, ins: insVecD, del: delVecD })),
  ...docTexts.map((d) => ({ kind: 'doc', id: d.id, text: d.text, ins: insVecD, del: delVecD })),
];
const t1 = Date.now();
const B = 32;
for (let i = 0; i < docs.length; i += B) {
  const batch = docs.slice(i, i + B);
  const vecs = (await extractor(batch.map((d) => d.text), { pooling: 'mean', normalize: true })).tolist();
  for (let j = 0; j < batch.length; j++) {
    const d = batch[j];
    const hash = createHash('sha256').update(d.text).digest('hex');
    const prev = getMeta.get(d.id);
    if (prev && prev.hash === hash && !args.has('--full')) { skipped++; continue; }
    if (prev?.vec_rowid) d.del.run(prev.vec_rowid); // delete stale vector (content changed)
    const r = d.ins.run(Buffer.from(new Float32Array(vecs[j]).buffer));
    meta.run(d.id, d.kind, hash, MODEL, Number(r.lastInsertRowid));
    embedded++;
  }
}
console.log(`embedded=${embedded} skipped(unchanged)=${skipped} in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
const cE = db.prepare('SELECT COUNT(*) c FROM entity_vecs').get().c;
const cS = db.prepare('SELECT COUNT(*) c FROM symbol_vecs').get().c;
console.log(`vec tables: entity_vecs=${cE} symbol_vecs=${cS}`);
db.close();