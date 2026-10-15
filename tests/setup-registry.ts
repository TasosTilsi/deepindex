import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every suite gets its own project registry. Without this the suite registers its temp projects in
// the real ~/.deepindex/projects.json, and the dashboard a user opens then lists 137 /tmp entries.
// Spawned CLI tests inherit it because their `env` spreads process.env.
process.env.DEEPINDEX_REGISTRY = join(
  mkdtempSync(join(tmpdir(), 'deepindex-registry-')),
  'projects.json'
);
