# ADR-006: MCP Server via @modelcontextprotocol/sdk

- **Status:** Accepted
- **Date:** 2026-08-11

## Context

Recall used FastMCP (Python). The TS ecosystem has an official MCP SDK. The alternative was hand-rolling the stdio JSON-RPC protocol.

## Decision

Use **`@modelcontextprotocol/sdk`** for the MCP server. It handles stdio JSON-RPC, tool registration, and protocol versioning. The project already uses `zod` (the SDK uses it for tool schemas).

## Consequences

- **Positive:** No protocol boilerplate; official, maintained; cross-harness (Claude Code, Codex, OpenCode, DeepSeek Harness all support MCP).
- **Negative:** New dependency.
