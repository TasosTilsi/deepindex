// Shared types.

export interface File {
  id: number;
  path: string;
  hash: string;
  mtime: number;
  size: number;
  language: string | null;
  parsedAt: number | null;
}

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'const'
  | 'let'
  | 'enum'
  | 'method';

export interface Symbol {
  id: number;
  fileId: number;
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface Import {
  id: number;
  fileId: number;
  source: string;
  resolvedFileId: number | null;
  resolved: boolean;
}

export type EdgeKind = 'imports' | 'calls' | 'extends';

export interface Edge {
  id: number;
  fromSymbolId: number;
  toSymbolId: number;
  kind: EdgeKind;
}

export interface Fingerprint {
  hash: string;
  version: number;
  confidence: number;
  size: number;
  updatedAt: string;
}

export interface FingerprintSignals {
  hashStable?: boolean;        // default true
  importsResolved?: number;   // 0-1
  testsPass?: number;         // 0-1
}

export interface CacheStats {
  totalSize: number;
  entryCount: number;
  oldestAccess: number;
  capacityBytes: number;
}
