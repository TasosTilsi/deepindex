// Shared package-version source (N-01/DI-05): --version, MCP serverInfo,
// and install-time command pinning must all report/spawn the SAME version,
// read from package.json. Resolves to src/ under tsx and dist/ in the
// published tarball — package.json sits one level up in both layouts.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package version from package.json. Falls back to 'unknown' if unreadable. */
export function readVersion(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  try {
    return (
      JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')) as {
        version?: string;
      }
    ).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** npx argv pinned to THIS package version (DI-05): bare `deepindex` assumes
 *  a global install and breaks pinned-npx consumers when a bare-npx cache
 *  path rotates. npxArgs('mcp', 'serve') → ['-y', 'deepindex@<ver>', 'mcp', 'serve']. */
export function npxArgs(...cliArgs: string[]): string[] {
  return ['-y', `deepindex@${readVersion()}`, ...cliArgs];
}

/** Hook command string pinned via npx (DI-05):
 *  npxCommand('hook', 'session-start') → 'npx -y deepindex@<ver> hook session-start'. */
export function npxCommand(...cliArgs: string[]): string {
  return ['npx', ...npxArgs(...cliArgs)].join(' ');
}