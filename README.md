# t3-mcp

Host-independent MCP connector for directly pairing [T3 Code](https://t3.gg) environments.
It does not require T3 Connect, a host-specific bot setup, or a local turn CLI.

## Install

Node.js 20 or newer is required.

```sh
npm install -g t3-mcp
t3-mcp
```

The process speaks MCP over stdio. A generic host configuration is:

```json
{
  "mcpServers": {
    "t3-mcp": {
      "command": "t3-mcp",
      "args": [],
      "env": {
        "T3_MCP_STATE_DIR": "/absolute/path/to/t3-mcp-state"
      }
    }
  }
}
```

`T3_MCP_STATE_DIR` is optional. Omit it to use the platform state directory outside the repository.
A host that does not use globally installed commands can use `"command": "npx"` with
`"args": ["--yes", "t3-mcp"]`.

The package contains exactly one skill, `t3-run-turn`, at `skills/t3-run-turn/SKILL.md`. It is
host-neutral and uses MCP tools rather than shell commands.

## Workflow

1. Pair directly with an environment using `add_environment` and either a `pairingUrl` or an
   `endpoint` plus `grant`. A pairing URL may carry its grant in a `?token=...` query or
   `#token=...` fragment. T3 Connect is not required.
2. Call `list_environments`, select an explicit environment `id`, then call `list_projects` with
   that id. Project and thread identifiers are scoped to the selected environment.
3. Use `start_turn` with `environmentId`, `projectId`, and `prompt` for a new thread. Use
   `continue_turn` with `environmentId`, `threadId`, and `prompt` for a new turn in an existing
   thread. A continuation never forks or silently queues work.
4. Observe with `get_thread`. History is bounded to 20 turns by default and 100 at most. When
   `history.hasMore` or `history.truncated` is true, pass `history.nextCursor` as `beforeCursor`
   to retrieve an older page instead of requesting unbounded history.
5. If a thread reports `approval_required` or `input_required`, resolve it in T3 Code and call
   `get_thread` again. This connector does not approve work or submit input on the user's behalf.
6. If `start_turn` or `continue_turn` returns `unknown`, do not retry immediately. Inspect the
   referenced thread with `get_thread` first; only then decide whether a retry is safe. Mutation
   requests are never automatically replayed.

After adoption, normal turns use these MCP tools. A local turn CLI, if one is available in a host,
is an optional debugging utility; this package never invokes `t3-turn`. Optional Connect support is
not part of this release chain.

## Tools

- `add_environment`: `pairingUrl?`, `endpoint?`, `grant?`, `label?`, `environmentId?`.
- `list_environments`: no arguments.
- `list_projects`: `environmentId`.
- `start_turn`: `environmentId`, `projectId`, `prompt`, and optional `modelSelection`.
- `continue_turn`: `environmentId`, `threadId`, `prompt`.
- `get_thread`: `environmentId`, `threadId`, and optional bounded `turnLimit`/`beforeCursor`.

Pairing URLs use the upstream `?token=...` or `#token=...` form. The response never includes the
grant, access token, authenticated URL, or raw upstream error body.

Mutation acknowledgements are not replayed. A partial result keeps the created thread reference,
and an ambiguous transport result is `unknown` so the caller can inspect the thread before retrying.

## Security

- HTTPS is required except for loopback endpoints.
- URL credentials and arbitrary query parameters are rejected. A pairing URL query may contain
  only `token`, and the connector removes it before making requests. Endpoint URLs with an explicit
  grant remain query-free.
- Redirects are rejected, so credentials are never forwarded to another origin.
- The registration file is outside the repository, owner-only, and atomically replaced.
- A failed re-pair leaves the existing registration unchanged.

## Supported contract

See [`docs/compatibility.md`](docs/compatibility.md) for the upstream version and the exact
descriptor, token exchange, scopes, and session checks used by this package.

Automated compatibility coverage runs an MCP client against the connector process and controlled
HTTP environments implementing the supported direct-pairing contract. No live direct-pairing smoke
check was run for this release because this workspace has no operator-provided environment endpoint
or grant; the controlled checks must not be read as a claim that a live T3 deployment was exercised.
