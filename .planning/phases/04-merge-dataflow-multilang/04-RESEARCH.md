# Phase 4: Merge — Data-Flow & Multi-Language Indexing - Research

**Researched:** 2026-08-11
**Domain:** Code Indexing, Data-Flow Analysis, Multi-Language Parsing
**Confidence:** HIGH

## Summary

This research documents the requirements for porting the indexing capabilities of `cobi-tool` (Python) into DeepIndex (TypeScript/Node.js). The goal is to extend DeepIndex from a symbol/import graph to a comprehensive knowledge graph that includes multi-language support (Java, C/C++, Go, Rust), SQL/data-flow extraction, and requirements traceability.

The implementation will leverage `web-tree-sitter` for multi-language parsing, a dual-path SQL extraction strategy (Regex + Parser), and a project-specific knowledge graph projection from the existing SQLite store.

**Primary recommendation:** Implement as a set of "Extraction Passes" that run after the initial symbol parse, populating specialized SQLite tables (`sql_queries`, `database_schemas`, etc.) which are then projected into the data-flow graph.

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Home repo = context-engineering-framework.
- **D-02:** Stack = TypeScript.
- **D-03:** Absorb full indexing (not just data-flow).
- **D-04:** Discuss → Plan → Implement.
- **D-05:** One database (SQLite schema v3).
- **D-06:** LLM optional (deterministic-first).
- **D-07:** Full Cobi scope. Port all 8 languages (TS, JS, Py, Java, C/C++, Go, Rust). Use web-tree-sitter WASM grammars.
- **D-13:** Hybrid sync. Port full sync toolset. If Atlassian MCP is present, index directly; otherwise, use JSON feeds.
- **D-14:** Dual-path extraction. Implement both Regex-only and formal SQL Parser paths.
- **D-15:** Dual-engine graph. Tiny adjacency map + BFS for standard use; Neo4j for massive repos (local install, no Docker).

### Claude's Discretion
- Standard approaches for dual-path SQL and dual-engine graph implementations.

### Deferred Ideas (OUT OF SCOPE)
- Mermaid diagram generation.
- Semantic search / embeddings.
- cobi's legacy `cli.py`, `search/`, `docs/`.
- cobi's `data_flows` table (never written).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Symbol Extraction | Parser (WASM) | API / Backend | Handled by `web-tree-sitter` grammars per language. |
| SQL Extraction | Parser (Regex) | API / Backend | Regexes identify query boundaries; formal parser extracts tables. |
| Data-Flow Graph | Graph Engine | Database / Storage | Projected from SQLite relations into adjacency map/Neo4j. |
| Requirement Sync | Sync Engine | External API | Interfaces with Jira/Confluence or JSON files. |
| Context Tagging | Analyzer | API / Backend | Heuristic-based tagging of entities based on keywords. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `web-tree-sitter` | Latest | Multi-lang parsing | Industry standard for fast, consistent parsing across languages. |
| `better-sqlite3` | Latest | Persistence | Used throughout DeepIndex; high performance for local graph storage. |
| `zod` | Latest | Schema Validation | Validates requirement JSON feeds and config files. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|-------------|-------------|
| `sql-parser-cst` | Latest | Formal SQL Parsing | Used in the "Formal Path" of D-14 for complex query analysis. |
| `neo4j-driver` | Latest | Large Graph Storage | Only when Neo4j is enabled for massive repositories. |

**Installation:**
```bash
npm install web-tree-sitter better-sqlite3 zod sql-parser-cst neo4j-driver
```

## Architecture Patterns

### System Architecture Diagram
`Source Files` $\to$ `Tree-Sitter (Symbols)` $\to$ `Regex/SQL-Parser (Data-Flow)` $\to$ `SQLite (V3 Schema)` $\to$ `Graph Projection` $\to$ `BFS/Neo4j Query`

### Recommended Project Structure
```
src/
├── parser/
│   ├── languages/      # Language-specific node-type maps
│   ├── sql-extractor.ts # Regex + Formal paths
│   └── config-parser.ts # XML/YAML/JSON mapping logic
├── graph/
│   ├── projection.ts    # SQLite -> Adjacency Map / Neo4j
│   └── queries.ts      # Impact analysis, Parallel storage
└── requirements/
    ├── sync.ts         # Jira/Confluence/JSON ingestion
    └── extractor.ts    # Atomic statement splitting
```

### Pattern 1: Node-Type Normalization
**What:** Map language-specific tree-sitter node types to a normalized set (`function`, `class`, `method`, `interface`).
**When to use:** During the symbol extraction pass for any supported language.
**Example:**
```typescript
// Based on cobi/core/parser.py
const JAVA_MAP = {
  'class_declaration': 'class',
  'method_declaration': 'method',
  'interface_declaration': 'interface'
};
```

### Anti-Patterns to Avoid
- **Hardcoded Impact Counts:** Do not use hardcoded constants for "impact"; always derive from the graph.
- **Direct Graph-to-File Edits:** All indices must go through the SQLite store before being projected to the graph.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SQL Parsing | Custom Recursive Descent | `sql-parser-cst` | SQL dialects are too complex for a custom parser. |
| Graph Traversal | Custom BFS from scratch | `networkx`-like logic / Neo4j | Use established graph algorithms for shortest path and impact. |
| XML Parsing | Regex-based XML | `fast-xml-parser` | XML structure requires a proper DOM/SAX parser for reliability. |

## Common Pitfalls

### Pitfall 1: Paren-Depth in SQL
**What goes wrong:** Simple comma-splitting in `CREATE TABLE` fails when columns have precision (e.g., `DECIMAL(10,2)`).
**Why it happens:** Commas exist inside parentheses.
**How to avoid:** Use a paren-depth counter when splitting column definitions.
**Warning signs:** Column names containing fragments of types (e.g., `2)`).

### Pitfall 2: Tree-Sitter Field Names
**What goes wrong:** Assuming the `name` field exists on all symbol nodes.
**Why it happens:** Different languages use different field names (e.g., `declarator` in C++).
**How to avoid:** Use a per-language `name_fields` list to check.

## Code Examples

### SQL Extraction Regexes (Ported from `sql_parser.py`)
```typescript
const SQL_PATTERNS = {
  select: /\b(SELECT\s+.*?\s+FROM\s+[\w.]+)/i,
  insert: /\b(INSERT\s+INTO\s+[\w.]+)/i,
  update: /\b(UPDATE\s+[\w.]+\s+SET)/i,
  delete: /\b(DELETE\s+FROM\s+[\w.]+)/i,
  create_table: /\b(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w.]+)/i,
};

const TABLE_PATTERNS = {
  from: /FROM\s+([\w.]+)/i,
  join: /JOIN\s+([\w.]+)/i,
  into: /INTO\s+([\w.]+)/i,
  update: /UPDATE\s+([\w.]+)/i,
  table: /TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([\w.]+)/i,
};
```

### Column Definition Splitter (Ported from `_parse_column_definitions`)
```typescript
function splitColumnDefinitions(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of text) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current) parts.push(current.trim());
  return parts;
}
```

### Requirements Atomic Extraction (Ported from `requirement_extractor.py`)
```typescript
const MODAL_PATTERN = /(?:^|(?<=[.!?])\s+)([A-Z][^.!?\n]{10,}(?:must|should|shall|will|can|cannot|may)\s+[^.!?\n]+[.!?])/gm;
const BULLET_PATTERN = /^[\s]*(?:[-*•]|\d+[.)]\s+)\s*(.+)/gm;
```

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `web-tree-sitter` provides stable WASM grammars for all 8 languages | Standard Stack | Blocked multi-lang indexing |
| A2 | SQLite v3 is sufficient for the tiny adjacency map implementation | Architecture | Performance degradation on huge repos |

## Open Questions

1. **Neo4j Integration:** How to handle Neo4j local installation check without Docker?
   - Recommendation: Use a simple connectivity check to `bolt://localhost:7687` and fail gracefully to the adjacency map.
2. **Atlassian MCP:** What is the specific schema for the Atlassian MCP's requirement fetch?
   - Recommendation: Define a generic `Requirement` interface and map MCP response to it.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Neo4j | Data-Flow Graph | ✗ | — | Adjacency map + BFS |
| Jira/Conf API | Requirement Sync | ✗ | — | Local JSON feeds |

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | Zod for requirement JSON feeds |
| V6 Cryptography | no | — |

### Known Threat Patterns for {stack}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL Injection (in indexer) | Tampering | Use parameterized queries for all SQLite writes |
| Path Traversal (in build) | Information Disclosure | Validate all `root_path` resolutions via `path.resolve` |

## Sources

### Primary (HIGH confidence)
- `/home/tasostilsi/Development/Projects/cobi-tool/cobi/core/parser.py` - Multi-lang node maps
- `/home/tasostilsi/Development/Projects/cobi-tool/cobi/core/sql_parser.py` - SQL regexes & column logic
- `/home/tasostilsi/Development/Projects/cobi-tool/cobi/core/graph_builder.py` - Projection logic
- `/home/tasostilsi/Development/Projects/cobi-tool/cobi/core/graph_queries.py` - Impact analysis logic
- `/home/tasostilsi/Development/Projects/cobi-tool/cobi/core/context_analyzer.py` - Tagging heuristics
- `/home/tasostilsi/Development/Projects/cobi-tool/cobi/requirements/requirement_extractor.py` - Atomic split logic
- `/home/tasostilsi/Development/Projects/cobi-tool/cobi/requirements/requirement_indexer.py` - Req schema

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Based on project-wide adoption of `web-tree-sitter` and `better-sqlite3`.
- Architecture: HIGH - Direct port of working `cobi-tool` patterns.
- Pitfalls: HIGH - Identified specific logic (paren-depth) in reference source.

**Research date:** 2026-08-11
**Valid until:** 2026-09-11
