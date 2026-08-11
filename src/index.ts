// DeepIndex public API entry point.
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
export { tokenize, tfidf, retrieve, DEFAULT_TOP_K } from './retrieve.js';
export {
  repair,
  stage1Rebuild,
  stage2CacheInvalidate,
  stage3GitHistory,
  stage4LLM,
  OpenAICompatibleClient,
  repairCacheKey,
  REPAIR_CACHE_PREFIX,
} from './repair.js';
export { parseVitestJson, parseEslintJson, parseCoverageJson } from './reflect.js';
export {
  createWatcher,
  type WatcherOptions,
  type WatcherHandle,
} from './watcher.js';
export { serve, type ServeOptions, type ServeHandle } from './serve.js';
export {
  adaptClaudeCode,
  type AdapterResult,
  type AdaptOptions,
  type AdapterSymbol,
  type AdapterTopFile,
  type AdapterNeighborhood,
} from './adapter-claude-code.js';
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
  RetrieveHit,
  RetrieveSymbol,
  RepairStageResult,
  RepairCost,
} from './types.js';
