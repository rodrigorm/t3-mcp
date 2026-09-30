# Live Smoke

The default smoke uses direct pairing against the local T3 Desktop/server. An optional Connect smoke
can use the same MCP client after operator authentication. Pairing output, Connect state, and OAuth
configuration contain credentials; keep them outside the repository and never paste them into logs,
issues, or commits.

## Prepare

Run from the repository checkout on the feature branch:

```sh
npm run build
npm link
mkdir -p /tmp/t3-mcp-smoke-state
chmod 700 /tmp/t3-mcp-smoke-state
```

Confirm the host is up:

```sh
curl -sS --max-time 5 -o /dev/null -w 'status=%{http_code}\n' http://127.0.0.1:3773/
```

Mint a short-lived one-time pairing. The exact command is:

```sh
t3 pair --ttl 5m --label t3-mcp-live-smoke
```

For a no-copy/no-log run, capture the CLI output in a private temporary file and let the smoke
runner extract the pairing URL without printing it:

```sh
PAIRING_FILE=/tmp/t3-mcp-live-pairing.txt
umask 077
trap 'rm -f "$PAIRING_FILE"' EXIT
t3 pair --ttl 5m --label t3-mcp-live-smoke >"$PAIRING_FILE" 2>&1
T3_MCP_STATE_DIR=/tmp/t3-mcp-smoke-state \
T3_MCP_PAIRING_FILE="$PAIRING_FILE" \
node scripts/smoke-live.mjs
```

The runner uses the linked `t3-mcp` command and prints redacted step summaries.
Select an operator-authorized disposable project with `T3_MCP_PROJECT_ID` and environment with
`T3_MCP_ENVIRONMENT_ID`. Set `T3_MCP_MODEL_INSTANCE` and `T3_MCP_MODEL` to the selected
environment's available provider/model. Set `T3_MCP_LOOPBACK_ENDPOINT` when using a different
local port. Supply these explicitly rather than relying on the script's developer defaults.
The pairing-file form extracts its grant privately and uses the configured loopback endpoint.

The first run saves the environment session in `/tmp/t3-mcp-smoke-state`. To re-pair that saved
environment with a fresh grant, set `T3_MCP_REPAIR_ENVIRONMENT_ID=<environment-id>`.

An endpoint plus one-time grant can be used instead of a pairing file:

```sh
T3_MCP_STATE_DIR=/tmp/t3-mcp-smoke-state \
T3_MCP_ENDPOINT=http://127.0.0.1:3773 \
T3_MCP_GRANT="$ONE_TIME_GRANT" \
node scripts/smoke-live.mjs
```

Keep `ONE_TIME_GRANT` in a protected, non-committed environment. Do not put it in this file or in
shell history.

## Sequence

The runner invokes the real MCP process and performs this sequence:

1. `add_environment` with the pairing URL, without printing the URL or grant.
2. `list_environments`.
3. `list_projects` for the environment that contains the target project.
4. `start_turn` with a non-mutating acknowledgement prompt.
5. `get_thread`, waiting for a settled thread when the first read reports `starting` or `running`.
6. `continue_turn` on the same thread only after a settled, non-error observation.
7. `get_thread` again, waiting for the continuation to settle without replaying it.

Each step reports `outcome=accepted`, `outcome=approval_required`, or `outcome=unknown`. An
`unknown` mutation is never replayed; inspect the reported thread in T3 Code first. If a thread
reports `approval_required` or `input_required`, resolve it in T3 Code and observe it again before
deciding whether any later action is safe.

## Connect smoke, blocked pending upstream authorization

Connect is optional and experimental. The pinned and inspected current upstream relay require
a `t3-code-relay` audience JWT. Hosted OAuth has no verified private JWT handoff to this package.
Resolve [the registration blocker](connect-registration-contract.md) before claiming this smoke.
Controlled HTTP fixture success is not evidence that the hosted login can authorize registration.

After a verified upstream client authorization contract exists, #16 requires an explicitly authorized
account, selected ready managed `cloudflare_tunnel` environment, and disposable project/model.
Configure the relay, OAuth token endpoint, and matching hosted-page client through the MCP process
environment. Keep callback exchanges and credentials private.

Run the installed package through an MCP client:

1. Start `connect_authenticate`, complete the browser flow, and poll sanitized status to success.
2. Discover and explicitly select one environment. Confirm discovery has not changed saved registrations.
3. Register a new identity or explicitly attach a matching existing registration. Confirm unrelated
   registrations survive and the selected environment retains one stable `environmentId`.
4. List environments and projects, then start a bounded turn in the chosen project.
5. Read the returned thread until settled. An acknowledgement is not completion.
6. Continue that same settled thread, then read until the continuation is settled.
7. Restart the connector and verify registration/session persistence.
8. Sign out of connector Connect login. Discovery must fail while a valid reachable environment
   session still permits project/thread reads. Connector sign-out does not unlink the environment's
   own managed tunnel.
9. Unregister the selected environment, restart, and verify its local access is gone while unrelated
   registrations remain usable.

Resolve approvals/user input in T3 Code. Never replay an ambiguous mutation; inspect its retained
thread/command identifiers. Save only sanitized outcomes and public IDs/version/timestamps.
Do not borrow host credentials or substitute administrative sessions for operator authorization.

No live direct-pairing or Connect smoke was performed during #14. The automated public MCP and
installed-package sequences use controlled local HTTP with fixture-issued JWTs and cryptographically
validated DPoP. #14 remains blocked on authorization handoff; #16 remains blocked on that contract
and an authorized real account/environment/project.
