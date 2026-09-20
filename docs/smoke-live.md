# Live Smoke

This smoke uses direct pairing against the local T3 Desktop/server. It does not use T3 Connect.
Pairing output and state contain credentials; keep both outside the repository and never paste them
into logs, issues, or commits.

## Prepare

Run from the repository checkout on `feat/t3-mcp-mvp`:

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

The runner uses the linked `t3-mcp` command, searches the paired environments for project
`f4d5edfb-adbb-48c4-8e45-7afdb69f1aca`, and prints only redacted step summaries. The capture form
also handles the Desktop CLI's local-LAN pairing URL by extracting its grant privately and sending
it to the required loopback endpoint. To use an explicit environment, add
`T3_MCP_ENVIRONMENT_ID=<environment-id>` without printing or committing a token.

This host's projects currently have no model default, so the runner explicitly uses
`instanceId=opencode` and `model=openai/gpt-5.6-luna`, matching the local `t3-turn` defaults. Override
them with `T3_MCP_MODEL_INSTANCE` and `T3_MCP_MODEL` when using another host.

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
