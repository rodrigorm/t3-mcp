# t3-mcp

Host-independent MCP connector for directly pairing [T3 Code](https://t3.gg) environments, with
optional operator-driven T3 Connect support. It does not require a host-specific bot setup or a local
turn CLI.

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
2. For the optional Connect path, call `connect_authenticate`, complete the browser flow, and call
   `list_connect_environments`. Discovery does not save environments; call
   `register_connect_environment` for a new saved environment or `attach_connect_environment` for
   an existing direct registration.
3. Call `list_environments`, select an explicit environment `id`, then call `list_projects` with
   that id. Project and thread identifiers are scoped to the selected environment.
4. Use `start_turn` with `environmentId`, `projectId`, and `prompt` for a new thread. Use
   `continue_turn` with `environmentId`, `threadId`, and `prompt` for a new turn in an existing
   thread. A continuation never forks or silently queues work.
5. Observe with `get_thread`. History is bounded to 20 turns by default and 100 at most. When
   `history.hasMore` or `history.truncated` is true, pass `history.nextCursor` as `beforeCursor`
   to retrieve an older page instead of requesting unbounded history.
6. If a thread reports `approval_required` or `input_required`, resolve it in T3 Code and call
   `get_thread` again. This connector does not approve work or submit input on the user's behalf.
7. If `start_turn` or `continue_turn` returns `unknown`, do not retry immediately. Inspect the
   referenced thread with `get_thread` first; only then decide whether a retry is safe. Mutation
   requests are never automatically replayed.

Connect configuration is supplied through the host environment: set
`T3_MCP_CONNECT_RELAY_URL`, `T3_MCP_CONNECT_CLIENT_ID`, and either
`T3_MCP_CONNECT_TOKEN_ENDPOINT` or a Clerk publishable key. Keep these values outside the repository;
the hosted authorization page defaults to `https://app.t3.codes`.

After adoption, normal turns use these MCP tools. A local turn CLI, if one is available in a host,
is an optional debugging utility; this package never invokes `t3-turn`.

## Tools

- `add_environment`: `pairingUrl?`, `endpoint?`, `grant?`, `label?`, `environmentId?`.
- `list_environments`: no arguments.
- `list_projects`: `environmentId`.
- `start_turn`: `environmentId`, `projectId`, `prompt`, and optional `modelSelection`.
- `continue_turn`: `environmentId`, `threadId`, `prompt`.
- `get_thread`: `environmentId`, `threadId`, and optional bounded `turnLimit`/`beforeCursor`.
- `connect_authenticate`: optional `action` of `start`, `status`, or `cancel`.
- `list_connect_environments`: no arguments; discovery only.
- `register_connect_environment`: `environmentId` and optional `label`.
- `attach_connect_environment`: `environmentId`, `targetEnvironmentId`, and optional `label`.
- `sign_out_connect`: no arguments; direct registrations are not removed.
- `unregister_environment`: `environmentId`.

Pairing URLs use the upstream `?token=...` or `#token=...` form. Direct-pairing responses never include
the grant, access token, or raw upstream error body. Connect authentication may return a browser
authorization URL, but not the resulting credentials.

Mutation acknowledgements are not replayed. A partial result keeps the created thread reference,
and an ambiguous transport result is `unknown` so the caller can inspect the thread before retrying.

## Security

- HTTPS is required except for loopback endpoints.
- URL credentials and arbitrary query parameters are rejected. A pairing URL query may contain
  only `token`, and the connector removes it before making requests. Endpoint URLs with an explicit
  grant remain query-free.
- Redirects are rejected, so credentials are never forwarded to another origin.
- Environment and Connect state are separate files outside the repository, owner-only, and atomically
  replaced. Connect access uses DPoP-bound keys and environment access is never included in MCP output.
- A failed re-pair leaves the existing registration unchanged.

## Supported contract

See [`docs/compatibility.md`](docs/compatibility.md) for the upstream version and the exact
descriptor, token exchange, scopes, and session checks used by this package.

Automated compatibility coverage runs an MCP client against the connector process and controlled
HTTP environments implementing the supported direct-pairing and Connect contracts. No live direct-pairing
or Connect smoke check was run for this release because this workspace has no operator-authorized
environment or Connect account; controlled checks must not be read as a claim that a live T3 deployment
was exercised.
