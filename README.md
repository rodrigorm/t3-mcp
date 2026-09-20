# t3-mcp

Host-independent MCP connector for directly pairing [T3 Code](https://t3.gg) environments.
It does not require T3 Connect or a host-specific bot setup.

## Install

```sh
npm install -g t3-mcp
t3-mcp
```

The process speaks MCP over stdio. Configure the command in an MCP host as `t3-mcp`.
Set `T3_MCP_STATE_DIR` only when an operator needs a non-default state location. The
default is a platform state directory outside the repository.

## Tools

Issue #2 ships the pairing slice:

- `add_environment`: accepts `pairingUrl` or `endpoint`, plus `grant` when the grant is not
  in the pairing URL fragment. An optional `label` names the saved registration. An explicit
  `environmentId` is required to replace an existing registration.
- `list_environments`: returns saved environment metadata, scopes, and known session expiry.

Pairing URL fragments use the upstream form `#token=...`. The response never includes the
grant, access token, authenticated URL, or raw upstream error body.

## Security

- HTTPS is required except for loopback endpoints.
- URL credentials and query parameters are rejected.
- Redirects are rejected, so credentials are never forwarded to another origin.
- The registration file is outside the repository, owner-only, and atomically replaced.
- A failed re-pair leaves the existing registration unchanged.

## Supported Contract

See [`docs/compatibility.md`](docs/compatibility.md) for the upstream version and the exact
descriptor, token exchange, scopes, and session checks used by this package.

The remaining MVP tools and the generic `t3-run-turn` skill are separate slices from issue #1.
