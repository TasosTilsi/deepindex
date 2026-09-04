// Phase 6: MCP stdio server (D-07). 6 read-only tools over the merged store.
// stderr-only logging — never write to stdout (corrupts MCP protocol).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type Database from 'better-sqlite3';
import {
  searchKnowledge,
  getEntity,
  getBacklinks,
  getDecisions,
  getBugs,
  getPatterns,
  searchKnowledgeSchema,
  getEntitySchema,
  getBacklinksSchema,
  typeListSchema,
} from './tools.js';

export interface McpServeOptions {
  dbPath?: string;
}

const DEFAULT_DB = '.ctx.db';

/** Create the MCP server with 6 read-only tools registered. */
export function createMcpServer(db: Database.Database): McpServer {
  const server = new McpServer(
    { name: 'deepindex', version: '0.1.0' },
    {
      instructions:
        'deepindex is an engineering knowledge graph built from this repository. ' +
        'Use search_knowledge for keyword search, get_decisions/get_bugs/get_patterns to browse by category, ' +
        'get_entity to fetch details by UUID or name, and get_backlinks to explore relationships. ' +
        'All responses are JSON.',
    }
  );

  server.registerTool(
    'search_knowledge',
    { title: 'Search knowledge', description: 'Full-text search across entity names and content (FTS5).', inputSchema: searchKnowledgeSchema },
    (args) => ({ content: [{ type: 'text', text: JSON.stringify(searchKnowledge(db, args)) }] })
  );

  server.registerTool(
    'get_entity',
    { title: 'Get entity', description: 'Fetch a single entity by UUID or exact name, with linked symbols + data-flow.', inputSchema: getEntitySchema },
    (args) => ({ content: [{ type: 'text', text: JSON.stringify(getEntity(db, args)) }] })
  );

  server.registerTool(
    'get_backlinks',
    { title: 'Get backlinks', description: 'Traverse entity relationships (multi-hop with cycle guard).', inputSchema: getBacklinksSchema },
    (args) => ({ content: [{ type: 'text', text: JSON.stringify(getBacklinks(db, args)) }] })
  );

  server.registerTool(
    'get_decisions',
    { title: 'Get decisions', description: 'List decision entities.', inputSchema: typeListSchema },
    (args) => ({ content: [{ type: 'text', text: JSON.stringify(getDecisions(db, args)) }] })
  );

  server.registerTool(
    'get_bugs',
    { title: 'Get bugs', description: 'List bug_fix entities.', inputSchema: typeListSchema },
    (args) => ({ content: [{ type: 'text', text: JSON.stringify(getBugs(db, args)) }] })
  );

  server.registerTool(
    'get_patterns',
    { title: 'Get patterns', description: 'List pattern entities.', inputSchema: typeListSchema },
    (args) => ({ content: [{ type: 'text', text: JSON.stringify(getPatterns(db, args)) }] })
  );

  return server;
}

/** Serve over stdio until the transport closes. */
export async function serveMcp(db: Database.Database): Promise<void> {
  const server = createMcpServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive until stdin closes.
  await new Promise<void>((resolvePromise) => {
    process.stdin.on('end', () => resolvePromise());
    process.stdin.on('close', () => resolvePromise());
  });
  await server.close();
}
