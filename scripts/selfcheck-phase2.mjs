// Phase 2 end-to-end self-check. Runs the full decision loop on
// fixtures/sample-repo and prints getHealth/retrieve/repair results.
// Phase 3 will replace this with a CLI; for now it's a smoke test.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  initDb,
  buildGraph,
  getHealth,
  retrieve,
  repair,
  parseVitestJson,
  recordSignal,
} from '../src/index.js';

const FIXTURE = resolve(process.cwd(), 'fixtures/sample-repo');

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'ctx-selfcheck-'));
  const dbPath = join(tmp, 'ctx.db');
  const db = initDb(dbPath);

  await buildGraph(db, FIXTURE);

  console.log('[selfcheck] getHealth:', JSON.stringify(getHealth(db), null, 2));
  console.log(
    '[selfcheck] retrieve("auth"):',
    JSON.stringify(retrieve(db, 'auth', { topK: 3, repoPath: FIXTURE }), null, 2)
  );
  console.log(
    '[selfcheck] repair:',
    JSON.stringify(await repair(db, FIXTURE), null, 2)
  );

  const vitestSample = {
    numTotalTests: 5,
    numPassedTests: 5,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [{ startTime: 0, endTime: 42 }],
  };
  const parsed = parseVitestJson(vitestSample);
  recordSignal(db, 'tests_pass', parsed.pass / parsed.total, 'vitest');
  recordSignal(db, 'tests_total', 1.0, 'vitest');
  console.log(
    '[selfcheck] getHealth after signal:',
    JSON.stringify(getHealth(db), null, 2)
  );
}

main().catch((err) => {
  console.error('[selfcheck] FAILED:', err);
  process.exit(1);
});
