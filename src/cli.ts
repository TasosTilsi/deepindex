#!/usr/bin/env node
import { Command } from 'commander';
import { buildGraph } from './graph/build.js';
import { initDb } from './graph/db.js';
import { cacheStats } from './cache.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const program = new Command();

program
  .name('ctx')
  .description('ContextKit — self-healing context engineering framework')
  .version('0.1.0');

program
  .command('build')
  .description('Index a repository: parse files, build graph, populate SQLite')
  .argument('<repo>', 'path to repository root')
  .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
  .action(async (repo: string, opts: { db: string }) => {
    const repoPath = resolve(repo);
    if (!existsSync(repoPath)) {
      console.error(`Repository not found: ${repoPath}`);
      process.exit(1);
    }
    const dbPath = resolve(opts.db);
    const db = initDb(dbPath);
    const stats = await buildGraph(db, repoPath);
    console.log(
      `indexed ${stats.fileCount} files, ${stats.symbolCount} symbols, ${stats.brokenImportCount} broken imports`
    );
  });

program
  .command('status')
  .description('Print cache + index stats')
  .option('-d, --db <path>', 'SQLite database path', '.ctx.db')
  .action((opts: { db: string }) => {
    const dbPath = resolve(opts.db);
    if (!existsSync(dbPath)) {
      console.log('no index — run `ctx build <repo>` first');
      return;
    }
    const stats = cacheStats(dbPath);
    console.log(
      `cache: ${stats.entryCount} entries, ${(stats.totalSize / 1024).toFixed(1)} KB / ${(stats.capacityBytes / 1024 / 1024).toFixed(0)} MB`
    );
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
