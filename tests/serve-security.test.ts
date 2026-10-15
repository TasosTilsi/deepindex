import { describe, it, expect } from 'vitest';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardLocalRequest, resolveDashboardDir, resolveWithin, serve } from '../src/serve.js';

/**
 * The HTTP surface is an origin a browser can reach.
 *
 * The server has no authentication, so anything a page the user merely visits can be made to send to
 * `127.0.0.1:7331` is reachable: a `text/plain` POST needs no preflight, and a `Host` header the
 * attacker controls turns DNS rebinding into a same-origin request. Two more rules were wrong:
 * `serve` preferred `cwd/dashboard/dist`, so a hostile repository's own JavaScript ran on that
 * origin, and the static containment check used `startsWith`, which a sibling directory sharing the
 * prefix passes.
 */
function raw(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = request(url, { method: options.method ?? 'GET', headers: options.headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c.toString()));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('which dashboard directory is served', () => {
  it('serves the bundled copy unless a caller names one explicitly', () => {
    // The development convenience — `cwd/dashboard/dist` — is gone: it let any repository the user
    // ran `serve` in serve its own JavaScript on this origin. The test has to work from a directory
    // that HAS a dashboard/dist, because in this checkout the bundled path and the cwd path are the
    // same file, which is exactly why the old rule looked harmless here.
    const decoy = mkdtempSync(join(tmpdir(), 'deepindex-serve-decoy-'));
    const previous = process.cwd();
    try {
      mkdirSync(join(decoy, 'dashboard', 'dist'), { recursive: true });
      writeFileSync(join(decoy, 'dashboard', 'dist', 'index.html'), '<!doctype html>PWNED');
      process.chdir(decoy);
      expect(resolveDashboardDir()).not.toContain(decoy);
      expect(resolveDashboardDir('/tmp/somewhere')).toBe('/tmp/somewhere');
    } finally {
      process.chdir(previous);
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});

describe('static containment', () => {
  it('accepts a path inside the directory and refuses escapes', () => {
    const dir = '/srv/app/dashboard/dist';
    expect(resolveWithin(dir, 'index.html')).toBe(join(dir, 'index.html'));
    expect(resolveWithin(dir, 'assets/app.js')).toBe(join(dir, 'assets/app.js'));
    expect(resolveWithin(dir, '../secrets.txt')).toBeNull();
    expect(resolveWithin(dir, '../../etc/passwd')).toBeNull();
    expect(resolveWithin(dir, '')).toBeNull();
    // The prefix bug: a sibling whose name starts with the same characters is not inside it.
    expect(resolveWithin(dir, '../dist-evil/secret.txt')).toBeNull();
  });
});

describe('local request guard', () => {
  const loopback = '127.0.0.1';

  it('allows a plain local request and a same-origin JSON POST', () => {
    expect(guardLocalRequest({ method: 'GET', headers: { host: '127.0.0.1:7331' } }, loopback)).toEqual({
      ok: true,
    });
    expect(
      guardLocalRequest(
        {
          method: 'POST',
          headers: {
            host: 'localhost:7331',
            origin: 'http://localhost:7331',
            'content-type': 'application/json',
          },
        },
        loopback
      )
    ).toEqual({ ok: true });
    // No Host header at all (a raw HTTP/1.0 client) is not a rebinding attempt.
    expect(guardLocalRequest({ method: 'GET', headers: {} }, loopback)).toEqual({ ok: true });
  });

  it('refuses a foreign Host, a foreign Origin, and a non-JSON POST', () => {
    expect(
      guardLocalRequest({ method: 'GET', headers: { host: 'evil.example:7331' } }, loopback)
    ).toEqual({ ok: false, reason: 'host' });
    expect(
      guardLocalRequest(
        { method: 'GET', headers: { host: '127.0.0.1:7331', origin: 'https://evil.example' } },
        loopback
      )
    ).toEqual({ ok: false, reason: 'origin' });
    expect(
      guardLocalRequest(
        { method: 'POST', headers: { host: '127.0.0.1:7331', 'content-type': 'text/plain' } },
        loopback
      )
    ).toEqual({ ok: false, reason: 'content-type' });
  });

  it('drops the Host and Origin rules when the caller deliberately binds elsewhere', () => {
    // `serve({ host })` is programmatic only; the CLI has no --host. A caller who exposes it on a
    // LAN gets a warning at startup, and the JSON-content-type rule still applies.
    expect(
      guardLocalRequest({ method: 'GET', headers: { host: '192.168.1.10:7331' } }, '0.0.0.0').ok
    ).toBe(true);
    expect(
      guardLocalRequest(
        { method: 'POST', headers: { host: '192.168.1.10:7331', 'content-type': 'text/plain' } },
        '0.0.0.0'
      ).ok
    ).toBe(false);
  });
});

// Port 0 lets the OS pick a free port. CTX_TEST_SKIP_SERVE mirrors the convention in serve.test.ts
// for environments that forbid spawning listeners.
describe.skipIf(process.env.CTX_TEST_SKIP_SERVE === '1')('the running server', () => {
  it('refuses a cross-site POST and a rebound Host, and still answers local API reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-serve-sec-'));
    const handle = await serve({ port: 0, dbPath: join(dir, 'test.db'), dashboardDir: join(dir, 'none') });
    const base = `http://127.0.0.1:${handle.port}`;
    try {
      const crossSite = await raw(`${base}/context`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ task: 'auth', repoPath: dir }),
      });
      expect(crossSite.status).toBe(403);

      const rebound = await raw(`${base}/api/overview`, { headers: { Host: 'evil.example' } });
      expect(rebound.status).toBe(403);

      const ok = await raw(`${base}/api/overview`);
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toHaveProperty('files');
    } finally {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
