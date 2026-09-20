# t3-mcp

Open-source **MCP connector + skills** for [T3 Code](https://t3.gg): run turns, list projects, and manage environments from any MCP host (e.g. Cursor / Grok Bot), **without** being tied to a personal multi-bot setup.

## Goals

- **Agnostic**: no Brook 99 / detective playbook, no host-specific conventions
- **Auth**: **direct environment pairing** (same idea as Desktop pairing) works without T3 Connect; **optional** T3 Connect for remote environments
- **MVP tools** (planned): environments (add/list), `list_projects`, `start_turn`, `continue_turn`, `get_thread`
- **Skills**: generic `t3-run-turn` only (no private playbooks)

Once live, bot turns should use these MCP tools; local `t3-turn` CLIs become optional host debug utilities.

## Status

Greenfield. Specs and tickets live in GitHub Issues.
