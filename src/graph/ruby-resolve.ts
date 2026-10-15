/**
 * Ruby's specifier-to-file mapping (issue #20).
 *
 * `require_relative 'helper'` is relative to the **file**, not to a load path, so it is one of the
 * few import forms in Ruby that names a file in this repository. A bare `require 'json'` names a
 * gem or the standard library and returns null here, leaving the caller to call it external.
 *
 * The extractor normalises `require_relative` to `./helper`, so a miss is then broken by the same
 * rule every relative import uses — which is right, because the form cannot point anywhere else.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function rubyResolve(repoRoot: string, fromFile: string, source: string): string | null {
  if (!source.startsWith('.')) return null;

  const stem = join(dirname(fromFile), source);
  for (const candidate of [stem.endsWith('.rb') ? stem : `${stem}.rb`, join(stem, 'index.rb')]) {
    if (isFile(resolve(repoRoot, candidate))) return candidate;
  }
  return null;
}
