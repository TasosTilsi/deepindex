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
  "SELECT s.id, s.name, s.kind, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.kind IN ('function','class','method','interface','type')"
).all();
const entText = (e) => `${e.type} | ${e.name.replace(/-/g, ' ')} | ${e.content}`;
const symText = (s) => `${s.kind} ${s.name} (in ${s.path})`;

const insVecE = db.prepare('INSERT INTO entity_vecs(embedding) VALUES (?)');
const insVecS = db.prepare('INSERT INTO symbol_vecs(embedding) VALUES (?)');
const delVecE = db.prepare('DELETE FROM entity_vecs WHERE rowid = ?');
const delVecS = db.prepare('DELETE FROM symbol_vecs WHERE rowid = ?');
const meta = db.prepare('INSERT OR REPLACE INTO poc_embed_meta(doc_id, kind, hash, model, vec_rowid) VALUES (?, ?, ?, ?, ?)');
const getMeta = db.prepare('SELECT hash, vec_rowid FROM poc_embed_meta WHERE doc_id = ?');

let embedded = 0, skipped = 0;
const docs = [
  ...ents.map((e) => ({ kind: 'entity', id: e.id, text: entText(e), ins: insVecE, del: delVecE })),
  ...syms.map((s) => ({ kind: 'symbol', id: String(s.id), text: symText(s), ins: insVecS, del: delVecS })),
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