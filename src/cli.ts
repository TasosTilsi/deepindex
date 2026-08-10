#!/usr/bin/env node
import { Command } from 'commander';
import { buildGraph } from './graph/build.js';
import { initDb } from './graph/db.js';
import { cacheStats, cacheDelete } from './cache.js';
import { getHealth, loadConfig, DEFAULT_HEALTH_CONFIG } from './health.js';
import { retrieve, DEFAULT_TOP_K } from './retrieve.js';
import { repair } from './repair.js';
import { createWatcher } from './watcher.js';
import { serve } from './serve.js';
import { adaptClaudeCode } from './adapter-claude-code.js';
import { projectFullGraph } from './graph/projection.js';
import { getImpact, findParallelStorage } from './graph/queries.js';
import { syncRequirements } from './requirements/sync.js';
import { calculateReqCoverage } from './requirements/coverage.js';
import { initRequirementsDb } from './requirements/setup.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const program = new Command();

program
  .name('ctx')
  .description('DeepIndex — self-healing context engineering framework')
  .version('0.1.0');

program
  .command('build')
  .description('Index a repository: parse files, build graph, populate SQLite')
  .argument('<repo>', 'path to repository root')
  .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
  .option('--rebuild', 'force re-parse, bypass hash cache', false)
  .action(async (repo: string, opts: { db: string; rebuild: boolean }) => {
    const repoPath = resolve(repo);
    if (!existsSync(repoPath)) {
      console.error(`ctx build: repository not found: ${repoPath}`);
      process.exit(2);
    }
    const dbPath = resolve(opts.db);
    const db = initDb(dbPath);
    try {
      const stats = await buildGraph(db, repoPath, { force: opts.rebuild });
      console.log(
        `indexed ${stats.fileCount} files, ${stats.symbolCount} symbols, ${stats.brokenImportCount} broken imports`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`ctx build: ${message}`);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Print JSON health report for a repository index')
  .argument('<repo>', 'path to repository root')
  .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
  .action((repo: string, opts: { db: string }) => {
    const repoPath = resolve(repo);
    const dbPath = resolve(opts.db);
    if (!existsSync(dbPath)) {
      console.log('no index — run `ctx build <repo>` first');
      process.exit(2);
    }
    if (!existsSync(repoPath)) {
      console.error(`ctx status: repository not found: ${repoPath}`);
      process.exit(2);
    }
    const config = loadConfig(repoPath) ?? DEFAULT_HEALTH_CONFIG;
    const db = initDb(dbPath);
    try {
      const report = getHealth(db, { config });
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.score >= config.repairBelow ? 0 : 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`ctx status: ${message}`);
      process.exit(2);
    }
  });

program
  .command('repair')
  .description('Run the 4-stage repair pipeline (deterministic → LLM)')
  .argument('<repo>', 'path to repository root')
  .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
  .option('--json', 'emit JSON to stdout', false)
  .action(async (repo: string, opts: { db: string; json: boolean }) => {
    const repoPath = resolve(repo);
    const dbPath = resolve(opts.db);
    if (!existsSync(dbPath)) {
      console.error(`ctx repair: no index — run \`ctx build <repo>\` first`);
      process.exit(2);
    }
    if (!existsSync(repoPath)) {
      console.error(`ctx repair: repository not found: ${repoPath}`);
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
      console.error(`ctx repair: ${message}`);
      process.exit(2);
    }
  });

program
  .command('retrieve')
  .description('Retrieve top-K files for a query')
  .argument('<query>', 'search query')
  .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
  .option('--top-k <n>', 'number of results', String(DEFAULT_TOP_K))
  .option('--json', 'emit JSON to stdout', false)
  .action((query: string, opts: { db: string; topK: string; json: boolean }) => {
    const dbPath = resolve(opts.db);
    if (!existsSync(dbPath)) {
      console.error(`ctx retrieve: no index — run \`ctx build <repo>\` first`);
      process.exit(2);
    }
    const topK = Number.parseInt(opts.topK, 10);
    if (!Number.isFinite(topK) || topK <= 0) {
      console.error(`ctx retrieve: invalid --top-k: ${opts.topK}`);
      process.exit(2);
    }
    const db = initDb(dbPath);
    try {
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
      console.error(`ctx retrieve: ${message}`);
      process.exit(1);
    }
  });

  program
    .command('index-requirements')
    .description('Index requirements from a JSON file')
    .argument('<file>', 'path to requirements JSON file')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
    .action(async (file: string, opts: { db: string }) => {
      const dbPath = resolve(opts.db);
      if (!existsSync(dbPath)) {
        console.error('ctx index-requirements: no index — run `ctx build <repo>` first');
        process.exit(2);
      }
      const db = initDb(dbPath);
      initRequirementsDb(db);
      try {
        const { imported, atomic } = syncRequirements(db, file);
        console.log(`Indexed ${imported} requirements and ${atomic} atomic statements.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`ctx index-requirements: ${message}`);
        process.exit(1);
      }
    });

  program
    .command('req-coverage')
    .description('Generate requirements traceability and coverage report')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
    .action((opts: { db: string }) => {
      const dbPath = resolve(opts.db);
      if (!existsSync(dbPath)) {
        console.error('ctx req-coverage: no index — run `ctx build <repo>` first');
        process.exit(2);
      }
      const db = initDb(dbPath);
      try {
        const report = calculateReqCoverage(db);
        console.log('Requirements Coverage Report');
        console.log('==================================================');

        console.log(`\\nOrphan Requirements (no linked code): ${report.orphanRequirements.length}`);
        for (const req of report.orphanRequirements) {
          console.log(`- [${req.id}] ${req.title}`);
        }

        console.log(`\\nUntracked Code (no linked requirement): ${report.untrackedCode.length}`);
        for (const code of report.untrackedCode) {
          console.log(`- ${code.filePath} [${code.symbol}]`);
        }

        console.log('==================================================');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`ctx req-coverage: ${message}`);
        process.exit(1);
      }
    });

  program
    .command('impact')
    .description('Find impact chain for a specific table (Table -> Query -> File -> Service)')
    .argument('<table_name>', 'name of the database table')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
    .option('--domain <domain>', 'filter by domain')
    .option('--region <region>', 'filter by region')
    .option('--system <system>', 'filter by system')
    .action((tableName: string, opts: { db: string; domain?: string; region?: string; system?: string }) => {
      const dbPath = resolve(opts.db);
      if (!existsSync(dbPath)) {
        console.error('ctx impact: no index — run `ctx build <repo>` first');
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
        console.error(`ctx impact: ${message}`);
        process.exit(1);
      }
    });

  program
    .command('parallel-storage')
    .description('Identify tables found in multiple storage systems')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
    .option('--domain <domain>', 'filter by domain')
    .option('--region <region>', 'filter by region')
    .option('--system <system>', 'filter by system')
    .action((opts: { db: string; domain?: string; region?: string; system?: string }) => {
      const dbPath = resolve(opts.db);
      if (!existsSync(dbPath)) {
        console.error('ctx parallel-storage: no index — run `ctx build <repo>` first');
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
        console.error(`ctx parallel-storage: ${message}`);
        process.exit(1);
      }
    });
  .description('Start the POST /context HTTP server')
  .option('-p, --port <n>', 'port number', '7331')
  .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
  .action(async (opts: { port: string; db: string }) => {
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isFinite(port) || port <= 0) {
      console.error(`ctx serve: invalid --port: ${opts.port}`);
      process.exit(2);
    }
    const dbPath = resolve(opts.db);
    let handle: Awaited<ReturnType<typeof serve>> | null = null;
    try {
      handle = await serve({ port, dbPath });
      console.log(`ctx serve: listening on 127.0.0.1:${handle.port}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`ctx serve: ${message}`);
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
  .command('watch')
  .description('Watch files for changes and invalidate summary cache')
  .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
  .option('--no-ignore', 'disable .gitignore and other default ignores')
  .option('--debounce <ms>', 'debounce window in ms', '250')
  .action((opts: { db: string; ignore: boolean; debounce: string }) => {
    const dbPath = resolve(opts.db);
    const debounce = Number.parseInt(opts.debounce, 10);
    if (!Number.isFinite(debounce) || debounce < 0) {
      console.error(`ctx watch: invalid --debounce: ${opts.debounce}`);
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
      console.error(`ctx watch: ${message}`);
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

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
