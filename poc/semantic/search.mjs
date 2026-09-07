// POC (poc/semantic-search branch): side-by-side semantic vs FTS5 search over
// entities, + vec-only symbol search. RRF hybrid shown as candidate ranking.
// Deps resolved from bench-tmp/node_modules until deps are promoted properly.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '/home/tasostilsi/Development/Projects/context-engineering-framework';
const req = createRequire(join(REPO, 'bench-tmp', 'package.json'));
const Database = req('better-sqlite3');
const sqliteVec = req('sqlite-vec');
const transformersPath = req.resolve('@huggingface/transformers');
const { pipeline, env } = await import(pathToFileURL(transformersPath));

env.cacheDir = join(REPO, 'bench-tmp', 'models');
env.allowLocalModels = false;

const argv = process.argv.slice(2);
const query = argv.filter((a) => !a.startsWith('--')).join(' ');
if (!query) { console.error('usage: node search.mjs <query> [--k 5]'); process.exit(1); }
const kIdx = argv.indexOf('--k');
const k = kIdx >= 0 ? Number(argv[kIdx + 1]) || 5 : 5;

const db = new Database(join(REPO, '.deepindex.db'), { readonly: true });
sqliteVec.load(db);

const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-l6-v2', { dtype: 'q8' });
const [qv] = (await extractor([query], { pooling: 'mean', normalize: true })).tolist();
const qbuf = Buffer.from(new Float32Array(qv).buffer);

// vec KNN through sqlite-vec; rowid → doc via poc_embed_meta (embed.mjs mapping)
const entHits = db.prepare('SELECT rowid, distance FROM entity_vecs WHERE embedding MATCH ? AND k = ?').all(qbuf, k);
const symHits = db.prepare('SELECT rowid, distance FROM symbol_vecs WHERE embedding MATCH ? AND k = ?').all(qbuf, k);
const docByRow = db.prepare("SELECT doc_id FROM poc_embed_meta WHERE kind = ? AND vec_rowid = ?");
const entById = db.prepare('SELECT name, type FROM entities WHERE id = ?');
const symById = db.prepare('SELECT s.name, s.kind, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?');

// FTS5 baseline (same query path as prod search)
const tokens = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).join(' OR ');
let ftsHits = [];
try {
  ftsHits = db.prepare('SELECT e.id, e.name, e.type FROM entities_fts f JOIN entities e ON e.rowid = f.rowid WHERE entities_fts MATCH ? LIMIT ?').all(tokens, k);
} catch {}

// RRF hybrid (k=60) over semantic + lexical entity rankings
const rrf = new Map();
entHits.forEach((h) => {
  const m = docByRow.get('entity', Number(h.rowid));
  if (m) rrf.set(m.doc_id, (rrf.get(m.doc_id) ?? 0) + 1 / (60 + entHits.indexOf(h) + 1));
});
ftsHits.forEach((h, i) => rrf.set(h.id, (rrf.get(h.id) ?? 0) + 1 / (60 + i + 1)));
const hybrid = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);

const fmtEnt = (id) => { const e = entById.get(id); return e ? `${e.type}  ${e.name.slice(0, 68)}` : id; };

console.log(`query: "${query}"\n`);
console.log('semantic (vec KNN, entities):');
for (const h of entHits) {
  const m = docByRow.get('entity', Number(h.rowid));
  console.log(`  ${Number(h.distance).toFixed(3)}  ${m ? fmtEnt(m.doc_id) : '?'}`);
}
console.log('lexical (FTS5, entities):');
if (!ftsHits.length) console.log('  (no hits)');
for (const h of ftsHits) console.log(`  -         ${h.type}  ${h.name.slice(0, 68)}`);
console.log('hybrid (RRF, entities):');
for (const [id] of hybrid) console.log(`  -         ${fmtEnt(id)}`);
console.log('semantic (symbols — no lexical baseline exists today):');
for (const h of symHits) {
  const m = docByRow.get('symbol', Number(h.rowid));
  if (!m) continue;
  const s = symById.get(m.doc_id);
  console.log(`  ${Number(h.distance).toFixed(3)}  ${s?.kind}  ${s?.name}  (${s?.path})`);
}
db.close();