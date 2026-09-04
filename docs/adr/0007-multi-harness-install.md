# ADR-007: Multi-Harness Install

- **Status:** Accepted
- **Date:** 2026-08-11

## Context

The framework integrates with multiple AI harnesses. Each has a different config format for hooks/MCP.

## Decision

`deepindex install` interactively prompts the user to choose harness(es): **Claude Code, Codex, OpenCode, DeepSeek Harness**. Each writes the correct config:
- Claude Code: `.claude/settings.json` (MCP + 4 hooks)
- Codex: `.codex/hooks.json` (4 hooks) + `.codex/config.toml` (MCP)
- OpenCode: `.opencode/plugins/deepindex/index.ts` (TS plugin)
- DeepSeek Harness: `~/.dsh/cordis.patch.yml` (`dsh-mcp-client` entry)

## Consequences

- **Positive:** One install command covers all major harnesses; additive (no clobber).
- **Negative:** Each harness has a different config format to maintain.
