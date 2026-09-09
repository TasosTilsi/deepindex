import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../src/serve.js';
import { registerProject } from '../src/registry.js';

// Port 0 lets the OS pick a free port, so this is safe alongside other suites.
// CTX_TEST_SKIP_SERVE mirrors the cli.test.ts convention for environments that
// forbid spawning listeners.
describe('serve', () => {
  it.skipIf(process.env.CTX_TEST_SKIP_SERVE === '1')(
    'serves /api/* across repeated requests and closes cleanly',
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'deepindex-serve-'));
      const handle = await serve({ port: 0, dbPath: join(tmpDir, 'test.db'), dashboardDir: join(tmpDir, 'no-dashboard') });
      try {
        const base = `http://127.0.0.1:${handle.port}`;
        // Two requests against the same project reuse the cached db handle.
        const r1 = await fetch(`${base}/api/overview`);
        const r2 = await fetch(`${base}/api/overview`);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        const body = (await r2.json()) as Record<string, unknown>;
        expect(body).toHaveProperty('files');
        expect(body).toHaveProperty('entities');
        const nf = await fetch(`${base}/api/nope`);
        expect(nf.status).toBe(404);
      } finally {
        await handle.close();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.env.CTX_TEST_SKIP_SERVE === '1')(
    'returns 500 (not a crash) for an unopenable project db and keeps serving',
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'deepindex-serve-'));
      const regPath = join(tmpDir, 'projects.json');
      // dbPath is a directory: initDb cannot open it, and there is no db
      // file to copy — the request must 500 without killing the process.
      registerProject({ name: 'bogus', path: join(tmpDir, 'bogus'), dbPath: tmpDir }, regPath);
      const handle = await serve({
        port: 0,
        dbPath: join(tmpDir, 'test.db'),
        registryPath: regPath,
        dashboardDir: join(tmpDir, 'no-dashboard'),
      });
      try {
        const base = `http://127.0.0.1:${handle.port}`;
        const bad = await fetch(`${base}/api/overview?project=bogus`);
        expect(bad.status).toBe(500);
        const badBody = (await bad.json()) as Record<string, unknown>;
        expect(badBody).toHaveProperty('error');
        expect(badBody).toHaveProperty('path');
        // Server survived: the default project still answers.
        const ok = await fetch(`${base}/api/overview`);
        expect(ok.status).toBe(200);
        const okBody = (await ok.json()) as Record<string, unknown>;
        expect(okBody).toHaveProperty('files');
      } finally {
        await handle.close();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  );
});