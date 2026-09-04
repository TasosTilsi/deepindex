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
import { projectFullGraph, validateProjection } from './graph/projection.js';
import { getImpact, findParallelStorage } from './graph/sql-impact.js';
import { syncRequirements } from './requirements/sync.js';
import { calculateReqCoverage } from './requirements/coverage.js';
import { initRequirementsDb } from './requirements/setup.js';
import { gitIndex, gitSync } from './git/indexer.js';
import { searchEntities } from './git/search.js';
import { serveMcp } from './mcp/server.js';
import { installClaudeSettings } from './mcp/install.js';
import { installInteractive, installHarness, type Harness } from './install.js';
import { registerProject } from './registry.js';
import { sessionStart } from './hooks/session-start.js';
import { userPromptSubmit } from './hooks/user-prompt-submit.js';
import { postToolUse } from './hooks/post-tool-use.js';
import { sessionEnd } from './hooks/session-end.js';
import { resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';

const program = new Command();

/** Shared preamble for read-only DB verbs: resolve --db, require an existing
 *  index, open the DB, run the action, format+exit on error. Centralizes the
 *  resolve/existsSync/initDb/try-catch boilerplate so each verb is its logic. */
function withDb<T>(
  verb: string,
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

program
  .name('deepindex')
  .description('DeepIndex — self-healing context engineering framework')
  .version('0.1.0');

program
  .command('index')
  .description('Index a repository: parse files, build graph, populate SQLite')
  .argument('<repo>', 'path to repository root')
  .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
  .option('--rebuild', 'force re-parse, bypass hash cache', false)
  .action(async (repo: string, opts: { db: string; rebuild: boolean }) => {
    const repoPath = resolve(repo);
    if (!existsSync(repoPath)) {
      console.error(`deepindex index: repository not found: ${repoPath}`);
      process.exit(2);
    }
    const dbPath = resolve(opts.db);
    const db = initDb(dbPath);
    try {
      const stats = await buildGraph(db, repoPath, { force: opts.rebuild });
      // Register the project so the multi-project dashboard can show it.
      // Non-fatal: indexing succeeds even if the registry can't be written.
      try {
        registerProject({ name: basename(repoPath), path: repoPath, dbPath });
      } catch {
        // registry write failed — ignore
      }
      console.log(
        `indexed ${stats.fileCount} files, ${stats.symbolCount} symbols, ${stats.brokenImportCount} broken imports`
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
  .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
  .action((repo: string, opts: { db: string }) => {
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
    const config = loadConfig(repoPath) ?? DEFAULT_HEALTH_CONFIG;
    const db = initDb(dbPath);
    try {
      const report = getHealth(db, { config });
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.score >= config.repairBelow ? 0 : 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`deepindex health: ${message}`);
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
    .command('sync-requirements')
    .description('Index requirements from a JSON file')
    .argument('<file>', 'path to requirements JSON file')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
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
    .command('check-req-coverage')
    .description('Generate requirements traceability and coverage report')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
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
        console.error(`deepindex check-req-coverage: ${message}`);
        process.exit(1);
      }
    });

  program
    .command('analyze-impact')
    .description('Find impact chain for a specific table (Table -> Query -> File -> Service)')
    .argument('<table_name>', 'name of the database table')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
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
    .command('check-parallel-storage')
    .description('Identify tables found in multiple storage systems')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
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
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
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
    .command('list-tables')
    .description('List all discovered database tables')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
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
    .command('find-table-usage')
    .description('Find code reading/writing a specific table')
    .argument('<table_name>', 'name of the database table')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
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
    .command('summarize-graph')
    .description('Print a summary of the indexed SQL-impact projection')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
    .action((opts: { db: string }) => {
      withDb('summarize-graph', opts, (db) => {
        const graph = projectFullGraph(db);
        console.log(`Projection built: ${graph.tables.size} tables, ${graph.queries.size} queries, ${graph.files.size} services.`);
      });
    });

  program
    .command('build-graph')
    .description('Build and validate the data-flow projection from indexed SQL/data-flow tables')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
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
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
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
    .command('git-index')
    .description('Index full git history into the knowledge graph (entities, backlinks, FTS5)')
    .argument('<repo>', 'path to git repository root')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
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
    .command('git-sync')
    .description('Incrementally index commits since last_indexed_sha')
    .argument('<repo>', 'path to git repository root')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
    .option('--full', 'force full reindex', false)
    .action((repo: string, opts: { db: string; full: boolean }) => {
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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`deepindex git-sync: ${message}`);
        process.exit(1);
      } finally {
        db.close();
      }
    });

  program
    .command('search')
    .description('Search the knowledge graph for typed entities via FTS5')
    .argument('<query>', 'search query')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
    .option('--limit <n>', 'number of results', '10')
    .action((query: string, opts: { db: string; limit: string }) => {
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
      const db = initDb(dbPath);
      try {
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
    .description('Install DeepIndex into an AI harness (Claude Code, Codex, OpenCode)')
    .option('--harness <name>', 'harness to install (claude-code | codex | opencode) — omit for interactive prompt')
    .action(async (opts: { harness?: string }) => {
      const projectRoot = process.cwd();
      if (opts.harness) {
        const valid: Harness[] = ['claude-code', 'codex', 'opencode', 'deepseek-harness'];
        if (!valid.includes(opts.harness as Harness)) {
          console.error(`deepindex install: unknown harness: ${opts.harness} (expected ${valid.join(' | ')})`);
          process.exit(2);
        }
        const r = installHarness(projectRoot, opts.harness as Harness);
        console.log(r.message);
        return;
      }
      const results = await installInteractive(projectRoot);
      for (const r of results) {
        console.log(r.message);
      }
      if (results.length === 0) {
        console.log('no harness selected — nothing installed');
      }
    });

  program
    .command('mcp')
    .description('MCP server commands')
    .argument('<subcommand>', 'serve | install')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
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
    .command('hook')
    .description('Claude Code hook entry points')
    .argument('<name>', 'session-start | user-prompt-submit | post-tool-use | session-end')
    .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
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
          result = sessionStart(repo, opts.db);
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

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
