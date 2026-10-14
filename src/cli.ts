#!/usr/bin/env node
import { Command } from 'commander';
import { buildGraph } from './graph/build.js';
import { initDb } from './graph/db.js';
import { cacheStats, cacheDelete } from './cache.js';
import {
  DEFAULT_HEALTH_CONFIG,
  DEFAULT_ISSUE_LIMIT,
  getHealth,
  loadConfig,
  recordSignal,
} from './health.js';
import { retrieve, DEFAULT_TOP_K } from './retrieve.js';
import { repair } from './repair.js';
import { createWatcher } from './watcher.js';
import { serve } from './serve.js';
import { adaptClaudeCode } from './adapter-claude-code.js';
import { projectFullGraph, validateProjection } from './graph/projection.js';
import { getImpact, findParallelStorage } from './graph/sql-impact.js';
import { syncRequirements, upsertRequirements } from './requirements/sync.js';
import {
  appendGuidance,
  backupFiles,
  existingTargets,
  guardClaudeSettings,
  guidanceTarget,
  scaffoldRepo,
} from './scaffold.js';
import {
  normalizeRequirements,
  type NormalizeReport,
  type RequirementFormat,
} from './requirements/sources.js';
import { calculateReqCoverage } from './requirements/coverage.js';
import { initRequirementsDb } from './requirements/setup.js';
import { clearSignals, normaliseSignalPairs } from './health.js';
import { parseEslintJson, parseJunitXml, parseVitestJson } from './reflect.js';
import { gitIndex, gitSync, syncSafe, type IndexResult } from './git/indexer.js';
import { searchEntities, type SearchHit } from './git/search.js';
import { hybridSearch, type HybridHit } from './semantic/search-hybrid.js';
import { serveMcp } from './mcp/server.js';
import { installClaudeSettings } from './mcp/install.js';
import { installInteractive, installHarness, type Harness } from './install.js';
import { registerProject } from './registry.js';
import { sessionStart } from './hooks/session-start.js';
import { userPromptSubmit } from './hooks/user-prompt-submit.js';
import { postToolUse } from './hooks/post-tool-use.js';
import { sessionEnd } from './hooks/session-end.js';
import { embed, autoEmbedStep } from './semantic/embed.js';
import {
  fetchModel,
  loadRealEmbedder,
  modelCacheDir,
  resolveModelName,
  checkModelPath,
  SemanticUnavailableError,
} from './semantic/embedder.js';
import { loadSemanticConfig } from './semantic/config.js';
import { readVersion } from './version.js';
import { basename, join, relative, resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type Database from 'better-sqlite3';

const program = new Command();

/** Shared preamble for read-only DB verbs: resolve --db, require an existing
 *  index, open the DB, run the action, format+exit on error. Centralizes the
 *  resolve/existsSync/initDb/try-catch boilerplate so each verb is its logic. */
function withDb<T>(  verb: string,
  opts: { db: string },
  fn: (db: Database.Database) => T
): void {
  const dbPath = resolve(opts.db);
  if (!existsSync(dbPath)) {
    console.error(`deepindex ${verb}: no index — run \`deepindex index <repo>\` first`);
    process.exit(2);
  }
  const db = initDb(dbPath);
  try {
    fn(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`deepindex ${verb}: ${message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

/** Freshness seam for read-only query verbs: delegates to git/syncSafe (DI-06).
 *  Non-fatal: if the repo isn't a git repo or sync fails, the query still runs. */
function syncBeforeQuery(db: Database.Database, repoPath: string): void {
  syncSafe(db, repoPath);
}

program
  .name('deepindex')
  .description('DeepIndex — self-healing context engineering framework')
  .version(readVersion());

program
  .command('index')
  .description('Index a repository: parse files, build graph, populate SQLite')
  .argument('<repo>', 'path to repository root')
  .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
  .option('--rebuild', 'force re-parse, bypass hash cache', false)
  .action(async (repo: string, opts: { db: string; rebuild: boolean }) => {
    const repoPath = resolve(repo);
    if (!existsSync(repoPath)) {
      console.error(`deepindex index: repository not found: ${repoPath}`);
      process.exit(2);
    }
    const dbPath = resolve(opts.db);
    // Long verb — signal life on stdout before the (potentially minutes-long)
    // parse so an npx one-shot doesn't look dead. stdout (not stderr) per
    // user decision: guaranteed visible even in stderr-swallowing contexts.
    console.log(`indexing ${repoPath} ...`);
    const db = initDb(dbPath);
    try {
      const stats = await buildGraph(db, repoPath, { force: opts.rebuild });
      // Also index git history into the knowledge graph (entities, backlinks).
      // Non-fatal: symbol indexing succeeds even if the repo isn't a git repo.
      // DI-07: degrade LOUDLY — a silently missing knowledge graph reads as a
      // broken install to scripted consumers.
      let gitStats: IndexResult | null = null;
      if (!existsSync(join(repoPath, '.git'))) {
        console.error(
          `deepindex index: not a git repository — knowledge-graph layer skipped (git-sync, search, and MCP entity tools will be empty for ${repoPath})`
        );
      }
      console.log('indexing git history ...');
      try {
        gitStats = gitIndex(db, repoPath);
      } catch {
        gitStats = null;
      }
      // Auto-embed after index (D-26b): gated on semantic.enabled AND a
      // cached model; never fatal, never downloads (no network here).
      try {
        await autoEmbedStep(db, repoPath);
      } catch (err) {
        // embedding failure never fails indexing (RSK-4) — but never silent:
        // the detail goes to stderr so embed bugs stay debuggable (REVIEW
        // INFO 8).
        console.error(`deepindex index: auto-embed skipped (${err instanceof Error ? err.message : String(err)})`);
      }
      // Register the project so the multi-project dashboard can show it.
      // Non-fatal: indexing succeeds even if the registry can't be written.
      try {
        registerProject({ name: basename(repoPath), path: repoPath, dbPath });
      } catch {
        // registry write failed — ignore
      }
      const gitPart = gitStats
        ? `, ${gitStats.entitiesInserted} entities, ${gitStats.relationshipsWritten} backlinks`
        : '';
      console.log(
        `indexed ${stats.fileCount} files, ${stats.symbolCount} symbols, ${stats.brokenImportCount} broken imports${gitPart}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`deepindex index: ${message}`);
      process.exit(1);
    }
  });

program
  .command('health')
  .description('Print JSON health report for a repository index')
  .argument('<repo>', 'path to repository root')
  .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
  .option('--issues-limit <n>', 'maximum issues to return', String(DEFAULT_ISSUE_LIMIT))
  .option('--issues-offset <n>', 'issues to skip, for paging', '0')
  .action((repo: string, opts: { db: string; issuesLimit: string; issuesOffset: string }) => {
    const repoPath = resolve(repo);
    const dbPath = resolve(opts.db);
    if (!existsSync(dbPath)) {
      console.log('no index — run `deepindex index <repo>` first');
      process.exit(2);
    }
    if (!existsSync(repoPath)) {
      console.error(`deepindex health: repository not found: ${repoPath}`);
      process.exit(2);
    }
    const issueLimit = Number.parseInt(opts.issuesLimit, 10);
    if (!Number.isFinite(issueLimit) || issueLimit < 0) {
      console.error(`deepindex health: invalid --issues-limit: ${opts.issuesLimit}`);
      process.exit(2);
    }
    const issueOffset = Number.parseInt(opts.issuesOffset, 10);
    if (!Number.isFinite(issueOffset) || issueOffset < 0) {
      console.error(`deepindex health: invalid --issues-offset: ${opts.issuesOffset}`);
      process.exit(2);
    }
    const config = loadConfig(repoPath) ?? DEFAULT_HEALTH_CONFIG;
    const db = initDb(dbPath);
    try {
      const report = getHealth(db, { config, issueLimit, issueOffset });
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.score >= config.repairBelow ? 0 : 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`deepindex health: ${message}`);
      process.exit(2);
    }
  });

program
  .command('signal')
  .description('Record test/lint signals into the health store')
  .argument('[signals...]', 'key=value pairs, e.g. tests_pass=148 tests_total=150')
  .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
  .option('--from-vitest <path>', 'parse a vitest JSON report (--reporter=json)')
  .option('--from-eslint <path>', 'parse an ESLint JSON report (-f json)')
  .option('--from-junit <path>', 'parse a JUnit XML file, or a directory of them')
  .option('--reset', 'delete every stored signal', false)
  .action(
    (
      signalArgs: string[],
      opts: {
        db: string;
        fromVitest?: string;
        fromEslint?: string;
        fromJunit?: string;
        reset: boolean;
      }
    ) => {
      // Parse and validate BEFORE opening the database: a usage error must never touch the
      // store, and the normalisation stays unit-testable (issue #4).
      const pairs: Record<string, number> = {};
      for (const raw of signalArgs) {
        const eq = raw.indexOf('=');
        const key = eq > 0 ? raw.slice(0, eq).trim() : '';
        const rawValue = eq > 0 ? raw.slice(eq + 1).trim() : '';
        const value = Number(rawValue);
        if (!key || rawValue === '' || !Number.isFinite(value)) {
          console.error(
            `deepindex signal: invalid signal pair: ${raw} (expected key=value)`
          );
          process.exit(2);
        }
        pairs[key] = value;
      }

      const reportFlags = [opts.fromVitest, opts.fromEslint, opts.fromJunit].filter(Boolean);
      if (opts.reset && (Object.keys(pairs).length > 0 || reportFlags.length > 0)) {
        console.error(
          'deepindex signal: --reset cannot be combined with signals or a report flag'
        );
        process.exit(2);
      }

      let source = 'cli';
      const readReport = (path: string): string => {
        if (!existsSync(path)) {
          console.error(`deepindex signal: report not found: ${path}`);
          process.exit(2);
        }
        return readFileSync(path, 'utf8');
      };

      try {
        if (opts.fromVitest) {
          source = 'vitest';
          const summary = parseVitestJson(JSON.parse(readReport(opts.fromVitest)));
          if (summary.total === 0) {
            // Same class as `tests_total=0` on the command line: the input cannot be
            // used, which is a usage error (exit 2), not a runtime failure.
            console.error('deepindex signal: ' + opts.fromVitest + ' contains no tests');
            process.exit(2);
          }
          pairs.tests_pass = summary.pass;
          pairs.tests_total = summary.total;
        }
        if (opts.fromEslint) {
          source = 'eslint';
          const summary = parseEslintJson(JSON.parse(readReport(opts.fromEslint)));
          pairs.lint_errors = summary.errors;
          // A clean run reports zero problems; the sentinel keeps the division safe.
          pairs.lint_total = Math.max(1, summary.total);
        }
        if (opts.fromJunit) {
          source = 'junit';
          const path = opts.fromJunit;
          if (!existsSync(path)) {
            console.error('deepindex signal: report not found: ' + path);
            process.exit(2);
          }
          const files = statSync(path).isDirectory()
            ? readdirSync(path)
                .filter((name) => name.endsWith('.xml'))
                .map((name) => join(path, name))
            : [path];
          if (files.length === 0) throw new TypeError(path + ' contains no .xml reports');
          let total = 0;
          let pass = 0;
          for (const file of files) {
            const summary = parseJunitXml(readFileSync(file, 'utf8'));
            total += summary.total;
            pass += summary.pass;
          }
          if (total === 0) {
            console.error('deepindex signal: ' + path + ' contains no tests');
            process.exit(2);
          }
          pairs.tests_pass = pass;
          pairs.tests_total = total;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`deepindex signal: ${message}`);
        process.exit(1);
      }

      let normalised: Record<string, number>;
      try {
        normalised = normaliseSignalPairs(pairs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`deepindex signal: ${message}`);
        process.exit(2);
      }

      withDb('signal', opts, (db) => {
        if (opts.reset) {
          const cleared = clearSignals(db);
          console.log(`cleared ${cleared} signal${cleared === 1 ? '' : 's'}`);
          return;
        }
        const entries = Object.entries(normalised);
        for (const [key, value] of entries) recordSignal(db, key, value, source);
        const rendered = entries.map(([key, value]) => `${key}=${value.toFixed(3)}`).join(', ');
        console.log(
          `recorded ${entries.length} signal${entries.length === 1 ? '' : 's'}: ${rendered}`
        );
      });
    }
  );

program
  .command('repair')
  .description('Run the 4-stage repair pipeline (deterministic → LLM)')
  .argument('<repo>', 'path to repository root')
  .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
  .option('--json', 'emit JSON to stdout', false)
  .action(async (repo: string, opts: { db: string; json: boolean }) => {
    const repoPath = resolve(repo);
    const dbPath = resolve(opts.db);
    if (!existsSync(dbPath)) {
      console.error(`deepindex repair: no index — run \`deepindex build <repo>\` first`);
      process.exit(2);
    }
    if (!existsSync(repoPath)) {
      console.error(`deepindex repair: repository not found: ${repoPath}`);
      process.exit(2);
    }
    const config = loadConfig(repoPath) ?? DEFAULT_HEALTH_CONFIG;
    const db = initDb(dbPath);
    const before = getHealth(db, { config });
    try {
      const result = await repair(db, repoPath);
      const after = getHealth(db, { config });
      if (opts.json) {
        console.log(
          JSON.stringify({ before, after, stages: result.stages, llmCost: result.llmCost }, null, 2)
        );
      } else {
        console.log(`before: ${before.score}`);
        for (const [i, s] of result.stages.entries()) {
          console.log(`stage ${i + 1}: ${s.ok ? 'ok' : 'fail'} — ${s.actions.join('; ')}`);
        }
        console.log(`after: ${after.score}`);
      }
      process.exit(after.score >= config.repairBelow ? 0 : 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`deepindex repair: ${message}`);
      process.exit(2);
    }
  });

program
  .command('retrieve')
  .description('Retrieve top-K files for a query')
  .argument('<query>', 'search query')
  .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
  .option('--top-k <n>', 'number of results', String(DEFAULT_TOP_K))
  .option('--json', 'emit JSON to stdout', false)
  .action((query: string, opts: { db: string; topK: string; json: boolean }) => {
    const dbPath = resolve(opts.db);
    if (!existsSync(dbPath)) {
      console.error(`deepindex retrieve: no index — run \`deepindex build <repo>\` first`);
      process.exit(2);
    }
    const topK = Number.parseInt(opts.topK, 10);
    if (!Number.isFinite(topK) || topK <= 0) {
      console.error(`deepindex retrieve: invalid --top-k: ${opts.topK}`);
      process.exit(2);
    }
    const db = initDb(dbPath);
    try {
      // Incremental git-sync before querying so entities are current.
      syncBeforeQuery(db, process.cwd());
      const hits = retrieve(db, query, { topK, repoPath: process.cwd() });
      if (opts.json) {
        console.log(JSON.stringify(hits, null, 2));
      } else {
        for (const h of hits) {
          const preview = h.summary.length > 100 ? h.summary.slice(0, 97) + '...' : h.summary;
          console.log(`${h.path}  score=${h.score.toFixed(3)}  ${preview}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`deepindex retrieve: ${message}`);
      process.exit(1);
    }
  });

  const requirements = program
    .command('requirements')
    .description('Import requirements from an external tracker export');

  requirements
    .command('import')
    .description('Import requirements from a Jira/GitHub export or a deepindex JSON file')
    .argument('<file>', 'path to the export file')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .option('--format <format>', 'jira | github | deepindex', 'deepindex')
    .option('--dry-run', 'normalise and report without writing', false)
    .option('--json', 'emit a JSON summary', false)
    .action(
      async (
        file: string,
        opts: { db: string; format: string; dryRun: boolean; json: boolean }
      ) => {
        const format = opts.format as RequirementFormat;
        if (!['jira', 'github', 'deepindex'].includes(format)) {
          console.error(`deepindex requirements import: invalid --format: ${opts.format}`);
          process.exit(2);
        }
        if (!existsSync(file)) {
          console.error(`deepindex requirements import: file not found: ${file}`);
          process.exit(2);
        }

        let report: NormalizeReport;
        try {
          report = normalizeRequirements(format, JSON.parse(readFileSync(file, 'utf8')));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`deepindex requirements import: ${message}`);
          process.exit(1);
        }

        for (const warning of report.warnings) {
          console.error(`deepindex requirements import: ${file}: ${warning}`);
        }

        if (opts.dryRun) {
          const summary = {
            imported: report.requirements.length,
            atomic: 0,
            skipped: report.skipped,
            warnings: report.warnings,
          };
          if (opts.json) console.log(JSON.stringify(summary, null, 2));
          else
            console.log(`Would import ${report.requirements.length} requirements (${report.skipped} skipped).`);
          return;
        }

        withDb('requirements import', opts, (db) => {
          initRequirementsDb(db);
          const { imported, atomic } = upsertRequirements(db, report.requirements);
          if (opts.json) {
            console.log(
              JSON.stringify({ imported, atomic, skipped: report.skipped, warnings: report.warnings }, null, 2)
            );
          } else {
            console.log(`Imported ${imported} requirements (${atomic} atomic statements) from ${format} export.`);
          }
        });
      }
    );

  program
    .command('sync-requirements', { hidden: true })
    .description('Index requirements from a JSON file')
    .argument('<file>', 'path to requirements JSON file')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .action(async (file: string, opts: { db: string }) => {
      const dbPath = resolve(opts.db);
      if (!existsSync(dbPath)) {
        console.error('deepindex sync-requirements: no index — run `deepindex index <repo>` first');
        process.exit(2);
      }
      const db = initDb(dbPath);
      initRequirementsDb(db);
      try {
        const { imported, atomic } = syncRequirements(db, file);
        console.log(`Indexed ${imported} requirements and ${atomic} atomic statements.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`deepindex sync-requirements: ${message}`);
        process.exit(1);
      }
    });

  program
    .command('check-req-coverage', { hidden: true })
    .description('Generate requirements traceability and coverage report')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .action((opts: { db: string }) => {
      const dbPath = resolve(opts.db);
      if (!existsSync(dbPath)) {
        console.error('deepindex check-req-coverage: no index — run `deepindex index <repo>` first');
        process.exit(2);
      }
      const db = initDb(dbPath);
      initRequirementsDb(db);
      try {
        const report = calculateReqCoverage(db);
        console.log('Requirements Coverage Report');
        console.log('==================================================');

        console.log('');
        console.log(`Orphan Requirements (no linked code): ${report.orphanRequirements.length}`);
        for (const req of report.orphanRequirements) {
          console.log(`- [${req.id}] ${req.title}`);
        }

        console.log('');
        console.log(`Untracked Code (no linked requirement): ${report.untrackedCode.length}`);
        for (const code of report.untrackedCode) {
          console.log(`- ${code.filePath} [${code.symbol}]`);
        }

        console.log('==================================================');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`deepindex check-req-coverage: ${message}`);
        process.exit(1);
      }
    });

  program
    .command('analyze-impact', { hidden: true })
    .description('Find impact chain for a specific table (Table -> Query -> File -> Service)')
    .argument('<table_name>', 'name of the database table')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .option('--domain <domain>', 'filter by domain')
    .option('--region <region>', 'filter by region')
    .option('--system <system>', 'filter by system')
    .action((tableName: string, opts: { db: string; domain?: string; region?: string; system?: string }) => {
      const dbPath = resolve(opts.db);
      if (!existsSync(dbPath)) {
        console.error('deepindex analyze-impact: no index — run `deepindex index <repo>` first');
        process.exit(2);
      }
      const db = initDb(dbPath);
      try {
        const graph = projectFullGraph(db);
        const impact = getImpact(graph, tableName, {
          domain: opts.domain,
          region: opts.region,
          system: opts.system,
        });

        if (impact.affectedQueries.length === 0) {
          console.log(`no queries found touching table: ${tableName} (or filtered out by context tags)`);
          process.exit(0);
        }

        console.log(`Impact report for table: ${tableName}`);
        console.log('--------------------------------------------------');

        for (const q of impact.affectedQueries) {
          const service = graph.files.get(q.file) || 'unknown service';
          console.log(`Query ${q.id} in ${q.file} -> ${service}`);
        }

        console.log('--------------------------------------------------');
        console.log(`Summary: ${impact.affectedFiles.length} files, ${impact.affectedServices.length} services affected.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`deepindex analyze-impact: ${message}`);
        process.exit(1);
      }
    });

  program
    .command('check-parallel-storage', { hidden: true })
    .description('Identify tables found in multiple storage systems')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .option('--domain <domain>', 'filter by domain')
    .option('--region <region>', 'filter by region')
    .option('--system <system>', 'filter by system')
    .action((opts: { db: string; domain?: string; region?: string; system?: string }) => {
      const dbPath = resolve(opts.db);
      if (!existsSync(dbPath)) {
        console.error('deepindex check-parallel-storage: no index — run `deepindex index <repo>` first');
        process.exit(2);
      }
      const db = initDb(dbPath);
      try {
        const graph = projectFullGraph(db);
        const parallel = findParallelStorage(graph, {
          domain: opts.domain,
          region: opts.region,
          system: opts.system,
        });

        if (parallel.length === 0) {
          console.log('no parallel storage detected');
          process.exit(0);
        }

        console.log('Parallel Storage Report:');
        console.log('--------------------------------------------------');
        for (const item of parallel) {
          console.log(`Table [${item.tableName}] found in: ${item.systems.join(', ')}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`deepindex check-parallel-storage: ${message}`);
        process.exit(1);
      }
    });
  program
    .command('serve')
    .description('Start the POST /context HTTP server')
    .option('-p, --port <n>', 'port number', '7331')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .action(async (opts: { port: string; db: string }) => {
      const port = Number.parseInt(opts.port, 10);
      if (!Number.isFinite(port) || port <= 0) {
        console.error(`deepindex serve: invalid --port: ${opts.port}`);
        process.exit(2);
      }
      const dbPath = resolve(opts.db);
      let handle: Awaited<ReturnType<typeof serve>> | null = null;
      try {
        handle = await serve({ port, dbPath });
        console.log(`deepindex serve: listening on 127.0.0.1:${handle.port}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`deepindex serve: ${message}`);
        process.exit(2);
      }
      const shutdown = async () => {
        if (handle) {
          await handle.close();
          handle = null;
        }
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });

  program
    .command('list-tables', { hidden: true })
    .description('List all discovered database tables')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .action((opts: { db: string }) => {
      withDb('list-tables', opts, (db) => {
        const tables = db.prepare('SELECT DISTINCT table_name FROM query_tables ORDER BY table_name').all() as { table_name: string }[];
        if (tables.length === 0) {
          console.log('no tables discovered');
        } else {
          console.log('Discovered Tables:');
          for (const t of tables) {
            console.log(`- ${t.table_name}`);
          }
        }
      });
    });

  program
    .command('find-table-usage', { hidden: true })
    .description('Find code reading/writing a specific table')
    .argument('<table_name>', 'name of the database table')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .action((tableName: string, opts: { db: string }) => {
      withDb('find-table-usage', opts, (db) => {
        const graph = projectFullGraph(db);
        const impact = getImpact(graph, tableName);
        if (impact.affectedQueries.length === 0) {
          console.log(`table ${tableName} not found in index`);
          return;
        }
        console.log(`Usage of table ${tableName}:`);
        for (const q of impact.affectedQueries) {
          const service = graph.files.get(q.file);
          const svc = service ? ` (${service})` : '';
          console.log(`- ${q.file}${svc}`);
        }
      });
    });

  program
    .command('summarize-graph', { hidden: true })
    .description('Print a summary of the indexed SQL-impact projection')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .action((opts: { db: string }) => {
      withDb('summarize-graph', opts, (db) => {
        const graph = projectFullGraph(db);
        console.log(`Projection built: ${graph.tables.size} tables, ${graph.queries.size} queries, ${graph.files.size} services.`);
      });
    });

  program
    .command('build-graph', { hidden: true })
    .description('Build and validate the data-flow projection from indexed SQL/data-flow tables')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .option('--json', 'emit JSON to stdout', false)
    .action((opts: { db: string; json: boolean }) => {
      withDb('build-graph', opts, (db) => {
        const graph = projectFullGraph(db);
        const v = validateProjection(db, graph);
        if (opts.json) {
          console.log(JSON.stringify(v, null, 2));
        } else {
          console.log(`Data-flow graph: ${v.tableCount} tables, ${v.queryCount} queries, ${v.serviceCount} services.`);
          const issues = v.queriesWithoutTables.length + v.filesWithSqlNoService.length;
          if (issues === 0) {
            console.log('Validation: OK');
          } else {
            console.log(`Validation: ${issues} issue(s)`);
            for (const qid of v.queriesWithoutTables) {
              console.log(`- query ${qid} has no table references`);
            }
            for (const f of v.filesWithSqlNoService) {
              console.log(`- file ${f} has SQL but no service mapping`);
            }
          }
        }
      });
    });

  program
    .command('watch')
    .description('Watch files for changes and invalidate summary cache')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .option('--no-ignore', 'disable .gitignore and other default ignores')
    .option('--debounce <ms>', 'debounce window in ms', '250')
    .action((opts: { db: string; ignore: boolean; debounce: string }) => {
      const dbPath = resolve(opts.db);
      const debounce = Number.parseInt(opts.debounce, 10);
      if (!Number.isFinite(debounce) || debounce < 0) {
        console.error(`deepindex watch: invalid --debounce: ${opts.debounce}`);
        process.exit(2);
      }
      const ignored = opts.ignore === false ? null : undefined;
      let handle: ReturnType<typeof createWatcher> | null = null;
      try {
        handle = createWatcher({
          dbPath,
          roots: [process.cwd()],
          debounceMs: debounce,
          ignored,
          onReady: () => console.log('watching'),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`deepindex watch: ${message}`);
        process.exit(1);
      }
      const shutdown = async () => {
        if (handle) {
          await handle.close();
          handle = null;
        }
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });

  program
    .command('git-index', { hidden: true })
    .description('Index full git history into the knowledge graph (entities, backlinks, FTS5)')
    .argument('<repo>', 'path to git repository root')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .action((repo: string, opts: { db: string }) => {
      const repoPath = resolve(repo);
      if (!existsSync(repoPath)) {
        console.error(`deepindex git-index: repository not found: ${repoPath}`);
        process.exit(2);
      }
      const db = initDb(resolve(opts.db));
      try {
        const r = gitIndex(db, repoPath);
        console.log(
          `indexed ${r.commitsProcessed} commits, ${r.entitiesInserted} entities inserted, ` +
            `${r.entitiesUpdated} updated, ${r.relationshipsWritten} backlinks`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`deepindex git-index: ${message}`);
        process.exit(1);
      } finally {
        db.close();
      }
    });

  program
    .command('git-sync', { hidden: true })
    .description('Incrementally index commits since last_indexed_sha')
    .argument('<repo>', 'path to git repository root')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .option('--full', 'force full reindex', false)
    .action(async (repo: string, opts: { db: string; full: boolean }) => {
      const repoPath = resolve(repo);
      if (!existsSync(repoPath)) {
        console.error(`deepindex git-sync: repository not found: ${repoPath}`);
        process.exit(2);
      }
      const db = initDb(resolve(opts.db));
      try {
        const r = opts.full ? gitIndex(db, repoPath) : gitSync(db, repoPath);
        if (r.commitsProcessed === 0) {
          console.log('0 commits to process');
        } else {
          console.log(
            `synced ${r.commitsProcessed} commits, ${r.entitiesInserted} entities inserted, ` +
              `${r.entitiesUpdated} updated, ${r.relationshipsWritten} backlinks`
          );
        }
        // Auto-embed after git-sync (D-26b) — same non-fatal gate as index.
        try {
          await autoEmbedStep(db, repoPath);
        } catch (err) {
          // embedding failure never fails git-sync (RSK-4) — never silent.
          console.error(`deepindex git-sync: auto-embed skipped (${err instanceof Error ? err.message : String(err)})`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`deepindex git-sync: ${message}`);
        process.exit(1);
      } finally {
        db.close();
      }
    });

  program
    .command('embed')
    .description('Embed the semantic corpus into vec tables (hash-guarded, incremental)')
    .argument('[repo]', 'path to repository root', '.')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .option('--fetch-model', 'download the configured embedding model into the local cache (explicit bootstrap — the only network path)', false)
    .option('--full', 'force re-embedding of every doc, ignoring the hash guard', false)
    .action(async (repo: string, opts: { db: string; fetchModel: boolean; full: boolean }) => {
      const repoPath = resolve(repo);
      if (!existsSync(repoPath)) {
        console.error(`deepindex embed: repository not found: ${repoPath}`);
        process.exit(2);
      }
      // --fetch-model bootstrap (D-23): download via fetchModel (THE network
      // path — loadRealEmbedder's cache gate cannot download), then verify
      // loadability once. Resolves the model from the SAME [semantic] config
      // the embed run will use, so the fetched model is the embedded model.
      if (opts.fetchModel) {
        const cfg = loadSemanticConfig(repoPath);
        const model = resolveModelName(cfg);
        // Issue #6: a configured local export IS the model. Downloading anyway would
        // be the one network call an air-gapped setup cannot make, so stop here.
        if (cfg.modelPath) {
          const check = checkModelPath(cfg.modelPath);
          if (check.ok) {
            console.log(`model_path ${check.dir} set — skipping download`);
            return;
          }
          console.error(`deepindex embed: ${check.message}`);
          process.exit(0);
        }
        try {
          await fetchModel(model);
          await loadRealEmbedder(model);
          console.log(`fetched model ${model} → cache ${modelCacheDir()}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Degradation posture (RSK-4): a failed fetch is a warning, not a
          // crash — lexical behaviour is fully functional without embeddings.
          if (err instanceof SemanticUnavailableError) {
            console.error(`deepindex embed: ${message}`);
            process.exit(0);
          }
          console.error(`deepindex embed: ${message}`);
          process.exit(1);
        }
      }
      const dbPath = resolve(opts.db);
      if (!existsSync(dbPath)) {
        console.error(`deepindex embed: no index — run \`deepindex index <repo>\` first`);
        process.exit(2);
      }
      const db = initDb(dbPath);
      try {
        // NO explicit model: embed()'s config-aware default re-derives the
        // same name from the same [semantic] config that --fetch-model warmed.
        const res = await embed(db, { rootDir: repoPath, full: opts.full });
        console.log(`embedded ${res.embedded}, skipped ${res.skipped} (model ${res.model})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof SemanticUnavailableError) {
          console.error(`deepindex embed: ${message}`);
          process.exit(0);
        }
        console.error(`deepindex embed: ${message}`);
        process.exit(1);
      } finally {
        db.close();
      }
    });

  program
    .command('search')
    .description('Search the knowledge graph for typed entities via FTS5')
    .argument('<query>', 'search query')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .option('--limit <n>', 'number of results', '10')
    .option('--semantic', 'semantic (vector) search — shorthand for --mode semantic', false)
    .option('--mode <mode>', 'search mode: lexical | semantic | hybrid (hybrid fuses FTS5 + vectors + file retrieval by RRF)')
    .action(async (query: string, opts: { db: string; limit: string; semantic?: boolean; mode?: string }) => {
      const dbPath = resolve(opts.db);
      if (!existsSync(dbPath)) {
        console.error(`deepindex search: no index — run \`deepindex git-index <repo>\` first`);
        process.exit(2);
      }
      const limit = Number.parseInt(opts.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        console.error(`deepindex search: invalid --limit: ${opts.limit}`);
        process.exit(2);
      }
      const rawMode = opts.mode ?? (opts.semantic ? 'semantic' : undefined);
      if (rawMode !== undefined && !['lexical', 'semantic', 'hybrid'].includes(rawMode)) {
        console.error(`deepindex search: invalid --mode: ${rawMode} (expected lexical | semantic | hybrid)`);
        process.exit(2);
      }
      const mode = rawMode as 'lexical' | 'semantic' | 'hybrid' | undefined;
      const db = initDb(dbPath);
      try {
        // Incremental git-sync before searching so entities are current.
        syncBeforeQuery(db, process.cwd());
        if (mode !== undefined) {
          // Mode-aware path (D-28b): the model resolves inside hybridSearch
          // from the [semantic] config at the repo (D-24) — repoPath only.
          const hits = await hybridSearch(db, query, { mode, limit, repoPath: process.cwd() });
          if (hits.length === 0) {
            console.log('no entities found');
          } else if (mode === 'lexical') {
            for (const h of hits as SearchHit[]) {
              console.log(`[${h.type}] ${h.name}  (rank ${h.rank.toFixed(2)})`);
              if (h.related.length > 0) {
                for (const r of h.related) {
                  console.log(`  -> ${r.relationship} ${r.type}:${r.name} (${r.context})`);
                }
              }
            }
          } else {
            for (const h of hits as HybridHit[]) {
              console.log(`[${h.kind}] ${h.label}  (score ${h.score.toFixed(3)})`);
              if (h.path) console.log(`  path: ${h.path}`);
              if (h.snippet) console.log(`  ${h.snippet}`);
            }
          }
          return;
        }
        const hits = searchEntities(db, query, limit);
        if (hits.length === 0) {
          console.log('no entities found');
        } else {
          for (const h of hits) {
            console.log(`[${h.type}] ${h.name}  (rank ${h.rank.toFixed(2)})`);
            if (h.related.length > 0) {
              for (const r of h.related) {
                console.log(`  -> ${r.relationship} ${r.type}:${r.name} (${r.context})`);
              }
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`deepindex search: ${message}`);
        process.exit(1);
      } finally {
        db.close();
      }
    });

  program
    .command('install')
    .description('Onboard a repository: config, gitignore, scripts, harness wiring, first index')
    .option('--harness <name>', 'harness to install (claude-code | codex | opencode | deepseek-harness) — omit for interactive prompt')
    .option('--dry-run', 'report what would change and write nothing', false)
    .option('--no-index', 'skip the initial index and health run')
    .option('--no-scripts', 'do not add the di:* npm scripts')
    .option('--guidance', 'document deepindex in CLAUDE.md/AGENTS.md without asking', false)
    .option('--skip-guidance', 'never document it, and do not ask')
    .action(
      async (opts: {
        harness?: string;
        dryRun: boolean;
        index: boolean;
        scripts: boolean;
        guidance: boolean;
        skipGuidance?: boolean;
      }) => {
        const projectRoot = process.cwd();
        const say = (line: string) => console.log(opts.dryRun ? `[dry-run] ${line}` : line);

        // 1. Guard BEFORE anything writes. installClaudeSettings swallows a parse failure and
        //    would replace the whole file, losing whatever the user had in it.
        const guard = guardClaudeSettings(projectRoot);
        for (const warning of guard.warnings) console.warn(`deepindex install: ${warning}`);
        if (guard.blocked) {
          console.error(`deepindex install: ${guard.message}`);
          process.exit(1);
        }

        if (opts.harness) {
          const valid: Harness[] = ['claude-code', 'codex', 'opencode', 'deepseek-harness'];
          if (!valid.includes(opts.harness as Harness)) {
            console.error(`deepindex install: unknown harness: ${opts.harness} (expected ${valid.join(' | ')})`);
            process.exit(2);
          }
        }

        // 2. Back up everything install may rewrite, before it rewrites it.
        const targets = existingTargets(projectRoot);
        const backupDir = backupFiles(projectRoot, targets, opts.dryRun);
        if (backupDir) {
          say(`backed up ${targets.length} file(s) -> ${relative(projectRoot, backupDir)}/`);
        }

        // 3. Harness wiring — the part install always did.
        if (opts.dryRun) {
          say(`would install the ${opts.harness ?? 'selected'} harness wiring`);
        } else if (opts.harness) {
          console.log(installHarness(projectRoot, opts.harness as Harness).message);
        } else {
          const results = await installInteractive(projectRoot);
          for (const r of results) console.log(r.message);
          if (results.length === 0) console.log('no harness selected — nothing installed');
        }

        // 4. The repo envelope: config, gitignore, npm scripts, optional CLAUDE.md nudge.
        // Ask before touching a file a human owns. --guidance says yes, --skip-guidance says
        // no, and a non-interactive run (CI, a pipe) is never asked: it is told how to ask.
        const target = guidanceTarget(projectRoot, opts.harness);
        let wantsGuidance = false;
        if (opts.guidance) wantsGuidance = true;
        else if (!opts.skipGuidance) {
          if (process.stdin.isTTY && process.stdout.isTTY) {
            const { createInterface } = await import('node:readline/promises');
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              const answer = await rl.question(
                `Document how to use deepindex in ${target}? [y/N] `
              );
              wantsGuidance = /^y(es)?$/i.test(answer.trim());
            } finally {
              rl.close();
            }
          } else {
            console.log(
              `deepindex install: not documenting deepindex in ${target} (no terminal to ask) — re-run with --guidance to add it`
            );
          }
        }

        for (const action of scaffoldRepo(projectRoot, readVersion(), {
          dryRun: opts.dryRun,
          guidance: wantsGuidance ? opts.harness : null,
          scripts: opts.scripts,
        }).actions) {
          say(action);
        }

        // 5. First index + health, so the repository is usable when the command returns.
        if (!opts.index || opts.dryRun) return;
        const db = initDb(join(projectRoot, '.deepindex.db'));
        try {
          const stats = await buildGraph(db, projectRoot);
          try {
            gitIndex(db, projectRoot);
          } catch {
            // Not a git repository: the symbol graph still built, which is the point.
          }
          const health = getHealth(db, { config: loadConfig(projectRoot) });
          console.log(`indexed ${stats.fileCount} files, ${stats.symbolCount} symbols — health ${health.score}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`deepindex install: index failed: ${message}`);
        } finally {
          db.close();
        }
      }
    );

  program
    .command('mcp')
    .description('MCP server commands')
    .argument('<subcommand>', 'serve | install')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .action(async (subcommand: string, opts: { db: string }) => {
      if (subcommand === 'install') {
        const r = installClaudeSettings(process.cwd());
        console.log(`installed MCP + hooks into ${r.path} (mcp: ${r.mcpAdded}, hooks: ${r.hooksAdded})`);
        return;
      }
      if (subcommand !== 'serve') {
        console.error(`deepindex mcp: unknown subcommand: ${subcommand} (expected serve | install)`);
        process.exit(2);
      }
      const dbPath = resolve(opts.db);
      if (!existsSync(dbPath)) {
        console.error(`deepindex mcp serve: no index — run \`deepindex index <repo>\` first`);
        process.exit(2);
      }
      const db = initDb(dbPath);
      try {
        await serveMcp(db);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`deepindex mcp serve: ${message}`);
        process.exit(1);
      } finally {
        db.close();
      }
    });

  program
    .command('hook', { hidden: true })
    .description('Claude Code hook entry points')
    .argument('<name>', 'session-start | user-prompt-submit | post-tool-use | session-end')
    .option('-d, --db <path>', 'SQLite database path', '.deepindex.db')
    .option('--repo <path>', 'repository path', '.')
    .option('--task <text>', 'task text (user-prompt-submit)')
    .option('--tool <name>', 'tool name (post-tool-use)')
    .option('--session <id>', 'session id')
    .option('--summary <text>', 'session summary (session-end)')
    .action(async (name: string, opts: { db: string; repo: string; task?: string; tool?: string; session?: string; summary?: string }) => {
      const repo = resolve(opts.repo);
      let result: { ok: boolean; message: string };
      switch (name) {
        case 'session-start':
          result = await sessionStart(repo, opts.db);
          break;
        case 'user-prompt-submit':
          result = await userPromptSubmit(opts.task ?? '', repo, opts.db);
          break;
        case 'post-tool-use':
          result = postToolUse(opts.tool ?? '', opts.session ?? 'unknown');
          break;
        case 'session-end':
          result = sessionEnd(opts.session ?? 'unknown', opts.summary ?? '');
          break;
        default:
          console.error(`deepindex hook: unknown hook: ${name}`);
          process.exit(2);
      }
      if (result.ok) {
        console.log(result.message);
      } else {
        console.error(`deepindex hook ${name}: ${result.message}`);
        process.exit(1);
      }
    });

program.addHelpText('after', `
Additional advanced commands (hidden from this list) are available:
  data-flow:   build-graph, list-tables, find-table-usage, summarize-graph,
               analyze-impact, check-parallel-storage
  requirements: sync-requirements, check-req-coverage
  health:       signal (feed test/lint results into the score)
  internal:    git-index, git-sync, hook
See docs/USAGE.md 'Advanced commands' for how to use them.`);

// Bare invocation (the typical npx one-shot entry): print help to stdout and
// exit 0. Commander's default is help-on-stderr + exit 1, which reads as
// "did nothing" in stderr-swallowing contexts. Handled BEFORE parseAsync so
// commander's own routing — including the unknown-command error path —
// stays completely untouched.
if (process.argv.slice(2).length === 0) {
  program.help(); // stdout, exit 0
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
