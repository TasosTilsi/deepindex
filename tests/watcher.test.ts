import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createWatcher } from '../src/watcher.js';

describe('watcher', () => {
  it('fires onInvalidate after the debounce window when a file is appended', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-watcher-debounce-'));
    const target = join(dir, 'a.ts');
    writeFileSync(target, 'export const x = 1;\n');

    let invalidated: string | null = null;
    let resolveEvent!: (v: string) => void;
    const event = new Promise<string>((res) => (resolveEvent = res));
    const timeout = new Promise<string>((_, rej) =>
      setTimeout(() => rej(new Error('onInvalidate timeout (2s)')), 2000)
    );

    const handle = createWatcher({
      roots: [dir],
      debounceMs: 100,
      dbPath: join(dir, 'test.db'),
      onInvalidate: (p) => {
        invalidated = p;
        resolveEvent(p);
      },
    });

    try {
      // Wait 50ms before the change so the watcher is fully ready.
      await new Promise((r) => setTimeout(r, 50));
      appendFileSync(target, '\nexport const y = 2;\n');
      const got = await Promise.race([event, timeout]);
      // Watcher reports path relative to process.cwd(), so reconstruct the
      // expected value via the same helper.
      const expected = relative(process.cwd(), target);
      expect(got).toBe(expected);
      expect(invalidated).toBe(expected);
    } finally {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('constructs with default opts and exposes a close() handle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-watcher-default-'));
    const handle = createWatcher({ dbPath: join(dir, 'test.db'), roots: [dir] });
    try {
      expect(typeof handle.close).toBe('function');
      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors ignored: null (--no-ignore) and constructs without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-watcher-noignore-'));
    const handle = createWatcher({
      dbPath: join(dir, 'test.db'),
      roots: [dir],
      ignored: null,
    });
    try {
      expect(typeof handle.close).toBe('function');
      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
