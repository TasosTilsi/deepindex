import type { Fingerprint, FingerprintSignals } from './types.js';

export function fingerprint(
  content: string | Buffer,
  signals: FingerprintSignals = {},
  version = 1
): Fingerprint {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const size = buf.length;
  const hash = sha256(buf);
  const confidence = computeConfidence(signals);
  const updatedAt = new Date().toISOString();
  return { hash, version, confidence, size, updatedAt };
}

function computeConfidence(signals: FingerprintSignals): number {
  const hashStable = signals.hashStable ?? true ? 1 : 0;
  const importsResolved = clamp01(signals.importsResolved ?? 1);
  const testsPass = clamp01(signals.testsPass ?? 1);
  return round3(hashStable * 0.4 + importsResolved * 0.3 + testsPass * 0.3);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

import { createHash } from 'node:crypto';

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}
