import { describe, it, expect } from 'vitest';
import { fingerprint, sha256 } from '../src/fingerprint.js';

describe('fingerprint', () => {
  it('hash is sha256 of content', () => {
    const fp = fingerprint('hello');
    expect(fp.hash).toBe(sha256('hello'));
  });

  it('different content → different hash', () => {
    expect(fingerprint('a').hash).not.toBe(fingerprint('b').hash);
  });

  it('size matches byte length', () => {
    const fp = fingerprint('hello');
    expect(fp.size).toBe(5);
  });

  it('updatedAt is parseable ISO date', () => {
    const fp = fingerprint('x');
    const parsed = new Date(fp.updatedAt);
    expect(parsed.toString()).not.toBe('Invalid Date');
  });

  it('confidence = 1 with all-default signals', () => {
    const fp = fingerprint('x');
    expect(fp.confidence).toBe(1);
  });

  it('confidence = 0 with all-zero signals', () => {
    const fp = fingerprint('x', { hashStable: false, importsResolved: 0, testsPass: 0 });
    expect(fp.confidence).toBe(0);
  });

  it('confidence = 0.7 with mixed signals', () => {
    const fp = fingerprint('x', { hashStable: true, importsResolved: 1, testsPass: 0 });
    // 0.4 * 1 + 0.3 * 1 + 0.3 * 0 = 0.7
    expect(fp.confidence).toBe(0.7);
  });

  it('version defaults to 1, can be overridden', () => {
    expect(fingerprint('x').version).toBe(1);
    expect(fingerprint('x', {}, 5).version).toBe(5);
  });
});
