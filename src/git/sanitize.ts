// Phase 5: Diff sanitization before any LLM call (D-14). Ports Recall v1.0
// sanitizer: high-entropy + pattern detection → [REDACTED:type].

// High-entropy threshold (Shannon entropy per char). Random-looking tokens
// (API keys, secrets) exceed this.
const ENTROPY_THRESHOLD = 3.5;
const MIN_TOKEN_LEN = 8;

/** Shannon entropy of a string (bits per char). */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Pattern detectors: regex → redaction label.
const PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'api_key', re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd|pwd)\s*[:=]\s*['"]?[A-Za-z0-9_\-\.]{8,}['"]?/gi },
  { label: 'aws_key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { label: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { label: 'connection_string', re: /\b(?:postgres|mysql|mongodb|redis|amqp):\/\/[^\s'"]+/gi },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

/** Sanitize a diff: redact known patterns and high-entropy tokens. */
export function sanitizeDiff(text: string): string {
  let out = text;
  for (const { label, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED:${label}]`);
  }
  // High-entropy tokens: split on non-alphanumeric boundaries, redact long
  // random-looking runs (hex/base64/uuid-like).
  out = out.replace(/[A-Za-z0-9_\-\.]{8,}/g, (tok) => {
    if (tok.startsWith('[REDACTED')) return tok;
    if (shannonEntropy(tok) >= ENTROPY_THRESHOLD && tok.length >= MIN_TOKEN_LEN) {
      return `[REDACTED:high_entropy]`;
    }
    return tok;
  });
  return out;
}
