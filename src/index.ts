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
  apiOverview,
  apiEntities,
  apiDataflow,
  apiSearch,
  apiSymbols,
  apiProjects,
  handleApi,
} from './dashboard/api.js';
export {
  loadRegistry,
  saveRegistry,
  registerProject,
  listProjects,
  getProject,
  defaultRegistryPath,
  type ProjectEntry,
  type Registry,
} from './registry.js';
export {
  adaptClaudeCode,
  type AdapterResult,
  type AdaptOptions,
  type AdapterSymbol,
  type AdapterTopFile,
  type AdapterNeighborhood,
} from './adapter-claude-code.js';
export {
  walkCommits,
  fetchDiff,
  fetchFilesChanged,
  batchCommits,
  type CommitRecord,
} from './git/walker.js';
export {
  extractDeterministic,
  extractLLMBatch,
  deriveRelationships,
  classifyType,
  deriveName,
  entityId,
  uuid5,
  ENTITY_TYPES,
  type EntityType,
  type EntityRecord,
  type RelationshipRecord,
  type ExtractionResult,
} from './git/extract.js';
export { sanitizeDiff, shannonEntropy } from './git/sanitize.js';
export { gitIndex, gitSync, deriveCommitType, type IndexResult } from './git/indexer.js';
export {
  searchEntities,
  getRelated,
  getRelatedRecursive,
  ftsQuery,
  type SearchHit,
  type RelatedEntity,
} from './git/search.js';
export { createMcpServer, serveMcp } from './mcp/server.js';
export {
  searchKnowledge,
  getEntity,
  getBacklinks,
  getDecisions,
  getBugs,
  getPatterns,
} from './mcp/tools.js';
export { installClaudeSettings } from './mcp/install.js';
export {
  installCodex,
  installOpenCode,
  installDsh,
  defaultDshConfigPath,
  installHarness,
  installInteractive,
  type Harness,
  type InstallResult,
} from './install.js';
export { sessionStart } from './hooks/session-start.js';
export { userPromptSubmit } from './hooks/user-prompt-submit.js';
export { postToolUse } from './hooks/post-tool-use.js';
export { sessionEnd } from './hooks/session-end.js';
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
