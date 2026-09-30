# t3-mcp

Host-independent MCP connector for directly pairing [T3 Code](https://t3.gg) environments, with
optional EXPERIMENTAL T3 Connect tools. It does not require a host-specific bot setup or a local
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
   `connect_authenticate` with `action=status` until authenticated, then call
   `list_connect_environments`. Discovery does not save environments; call
   `register_connect_environment` for a new saved environment or `attach_connect_environment` for
    an existing direct registration. Open the returned loopback URL on the connector host.
    Enter your identifier, password or verification codes only in that page. The connector
    creates its own native Clerk client/session and verifies its `t3-relay` JWT with the relay.
    See [the Desktop authentication contract](docs/connect-auth-contract.md).
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

Connect uses the public Desktop defaults: Clerk key `pk_live_Y2xlcmsudDMuY29kZXMk`, template
`t3-relay` and relay `https://relay.t3.codes`. Optional overrides are
`T3_MCP_CONNECT_CLERK_PUBLISHABLE_KEY`, `T3_MCP_CONNECT_CLERK_JWT_TEMPLATE`,
`T3_MCP_CONNECT_FRONTEND_API_URL` and `T3_MCP_CONNECT_RELAY_URL`.
`T3_MCP_CONNECT_CALLBACK_PORT` defaults to an OS-assigned loopback UI port. No CLI OAuth
client ID or token endpoint is needed.

The existing-account UI follows Clerk's offered email-code/password first factors and
authenticator, backup, SMS or email second factors/client-trust verification. Unsupported
social/SSO, passkey, reset, registration, session-task and challenge steps report specific
recovery guidance. Configure an allowed factor in T3 account settings before retrying.
The connector never captures installed Desktop callbacks or copies host login tokens.

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
- `sign_out_connect`: no arguments; saved registrations and environment sessions are not removed.
- `unregister_environment`: `environmentId`.

Pairing URLs use the upstream `?token=...` or `#token=...` form. Direct-pairing responses never include
the grant, access token, or raw upstream error body. Connect authentication may return a browser
authorization URL, but not the resulting credentials.

To attach Connect to a saved direct registration, pass the discovered `environmentId` and the
saved `id` as `targetEnvironmentId` to `attach_connect_environment`. These identifiers must match;
the connector checks the relay and environment descriptor identities before exchanging the bootstrap.
Equal labels are not identity evidence. Successful attachment keeps one registration and its stable
id, preserves the saved label unless `label` is supplied, and selects Connect access while retaining
the direct session, including registrations saved before Connect existed.

Failed attachment or direct re-pairing preserves the saved access. To repair direct access, call
`add_environment` with the saved `environmentId` and a fresh environment-issued pairing grant.
Success selects direct access and retains the attached Connect session. Both paths survive restart
and Connect sign-out. Safe reads and mutation preflight can use a retained alternate path after
transport failure or session expiry/revocation; submitted mutations are never replayed on another path.

To forget a saved environment, call `unregister_environment` with its `environmentId` from
`list_environments`. This removes that registration and all of its locally retained direct and
Connect access. The removal survives connector restarts, and project and turn tools can no longer
target it. Other saved environments remain usable. Unregistration does not sign out of Connect and
does not revoke the upstream session. Revoke access in T3 Code if upstream revocation is required.

If unregistration overlaps a re-pair or Connect attachment to the same registration, that exchange
cannot restore the removed target. If the target changes during an exchange, the exchange returns
an error and preserves the newer registration. Select the current registration again before retrying.

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
- The native Client API credential and cached template JWT have separate lifecycles. Restart
  verifies the owned session and renews through the public session-template API. Stored native
  state is plaintext with private permissions; run one connector process per state directory.
- Obsolete OAuth login state requires native reauthentication. Saved environment access and
  proof keys survive migration. Account switching requires explicit Connect sign-out.
- A failed re-pair leaves the existing registration unchanged.

## Compatibility and evidence

See [`docs/compatibility.md`](docs/compatibility.md) for the upstream version and the exact
descriptor, token exchange, scopes, and session checks used by this package.

Automated compatibility coverage runs an MCP client against the connector process and controlled
HTTP environments implementing public native Clerk, direct-pairing and relay-JWT contracts. Tests include
cryptographic DPoP validation, installed-package turns for registration and attachment, lifecycle
isolation across restart, supported factors/client trust, client rotations, template renewal,
and the packaged smoke runners. No live direct-pairing
or Connect smoke check was run for this release because this workspace has no operator-authorized
environment or Connect account; controlled checks must not be read as a claim that a live T3 deployment
was exercised.

For repeatable installed-package verification, see [`docs/smoke-live.md`](docs/smoke-live.md).
The optional runners require explicit targets and use fresh disposable state. They print only
local browser authorization URLs and safe summary codes. Direct pairing remains the default.
The remaining real Connect smoke requires operator login and authorized remote machines/project.
Public metadata checks and automated fixtures are recorded separately from live evidence.
