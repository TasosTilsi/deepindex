// ContextKit public API entry point.
export { initDb, getDb } from './graph/db.js';
export { buildGraph } from './graph/build.js';
export { fingerprint } from './fingerprint.js';
export { cacheSet, cacheGet, cacheDelete, cacheStats } from './cache.js';
export {
  loadConfig,
  getHealth,
  recordSignal,
  getSignals,
  DEFAULT_HEALTH_CONFIG,
} from './health.js';
export { parseVitestJson, parseEslintJson, parseCoverageJson } from './reflect.js';
export type {
  Fingerprint,
  CacheStats,
  Symbol,
  File,
  Import,
  Edge,
  HealthDims,
  HealthReport,
  HealthIssue,
  HealthConfig,
} from './types.js';
