# Installed-package smoke verification

Direct pairing is the default. Connect is optional and EXPERIMENTAL. These runners are
optional verification utilities; normal setup and turns use the MCP tools in the host.
They launch the installed `t3-mcp` stdio command through a real MCP client and contact
the configured upstream HTTP services. They never invoke a turn CLI.

## Install the package under test

Use a packed artifact from the integration branch, rather than a globally linked checkout.
For example, set `SMOKE_INSTALL` to a fresh installation directory and install the selected
artifact there:

```sh
SMOKE_INSTALL="$(mktemp -d)"
npm install --prefix "$SMOKE_INSTALL" /absolute/path/to/t3-mcp-0.1.0.tgz
export T3_MCP_COMMAND="$SMOKE_INSTALL/node_modules/.bin/t3-mcp"
```

The artifact includes both runners and this guide. Each run creates a fresh owner-only
temporary state directory and removes it on exit. The runners ignore `T3_MCP_STATE_DIR`
and never read, copy, repair, or unregister production registrations. They still create
a real thread and two turns in the explicitly selected upstream project. Use disposable
operator-authorized resources. Local cleanup does not revoke upstream sessions or delete
the upstream thread.

Both runners require `T3_MCP_ENVIRONMENT_ID` and `T3_MCP_PROJECT_ID`. There are no private
host, project, model, or provider defaults and no automatic target selection. The selected
project must have a default model, or supply both `T3_MCP_MODEL_INSTANCE` and `T3_MCP_MODEL`
from that environment's available models. Optional `T3_MCP_START_PROMPT` and
`T3_MCP_CONTINUE_PROMPT` replace the default acknowledgement-only prompts.

`T3_MCP_WAIT_MS` bounds each turn observation, default 120000. `T3_MCP_AUTH_WAIT_MS`
bounds each browser login, default 600000. `T3_MCP_POLL_MS` controls polling, default 1000.
All must be positive integers.

## Direct smoke

Obtain a fresh one-time pairing grant from the selected environment through T3 Code.
Supply either `T3_MCP_PAIRING_URL`, `T3_MCP_PAIRING_FILE`, or both `T3_MCP_ENDPOINT` and
`T3_MCP_GRANT` through a protected environment. The pairing file may contain QR/CLI output;
the runner extracts its token-bearing URL privately and preserves the exact endpoint.
It never substitutes a loopback address for a remote URL.

For a protected pairing file and explicit public identifiers:

```sh
T3_MCP_PAIRING_FILE="$PRIVATE_PAIRING_FILE" \
T3_MCP_ENVIRONMENT_ID="$SELECTED_ENVIRONMENT_ID" \
T3_MCP_PROJECT_ID="$DISPOSABLE_PROJECT_ID" \
node "$SMOKE_INSTALL/node_modules/t3-mcp/scripts/smoke-live.mjs"
```

The sequence is `add_environment`, exact identity check, `list_environments`, `list_projects`,
`start_turn`, `get_thread` until completed, `continue_turn` on that same thread, and
`get_thread` until the continuation completes. This path needs no Connect configuration.

## Connect smoke

The live run is currently blocked. Hosted OAuth tokens cannot satisfy the relay's JWT-only
registration exchange without a verified upstream authorization handoff. See
[the contract and blocker](connect-registration-contract.md). Login/discovery success,
public metadata availability, and fixture success do not satisfy the live gate.

Before running, provide all of these:

- An upstream-owned public-client authorization contract that privately delivers and renews
  the relay-compatible subject, or deliberately supports OAuth subjects. The pinned and
  inspected current upstream do not provide this handoff. A different client ID or re-login
  does not repair an opaque token.
- An explicitly authorized Connect account, matching hosted-page OAuth client and token
  endpoint, and an accepted loopback callback URI on the connector host. The browser must
  reach that host's callback. Port 34338 is the upstream default; another port requires the
  OAuth application's redirect policy to allow it.
- Two explicitly selected, distinct, ready managed `cloudflare_tunnel` environments.
  `T3_MCP_ENVIRONMENT_ID` is the turn target. `T3_MCP_SANITY_CONNECT_ENVIRONMENT_ID` is
  a separate registration used to verify that unregistration leaves other access working.
  Its project list must be nonempty. Discovery never chooses these for the operator.
- A disposable project and usable model on the turn target. To verify attachment, also
  supply a fresh direct pairing grant for exactly that target identity.

Configure `T3_MCP_CONNECT_RELAY_URL`, `T3_MCP_CONNECT_CLIENT_ID`, and
`T3_MCP_CONNECT_TOKEN_ENDPOINT` or `T3_MCP_CONNECT_CLERK_PUBLISHABLE_KEY` from the verified
deployment. Set `T3_MCP_CONNECT_HOSTED_APP_URL` if its hosted page differs from the package's
public default. Keep grants, callback exchanges, tokens, and private keys outside logs,
shell history, issue text, and committed files.

Run registration and attachment as separate checks with fresh smoke state:

```sh
T3_MCP_CONNECT_ACTION=register \
T3_MCP_ENVIRONMENT_ID="$SELECTED_ENVIRONMENT_ID" \
T3_MCP_SANITY_CONNECT_ENVIRONMENT_ID="$SANITY_ENVIRONMENT_ID" \
T3_MCP_PROJECT_ID="$DISPOSABLE_PROJECT_ID" \
node "$SMOKE_INSTALL/node_modules/t3-mcp/scripts/smoke-connect.mjs"
```

For attachment, use `T3_MCP_CONNECT_ACTION=attach` and supply the target's protected direct
pairing input as described above. The runner first pairs the target in its disposable state,
then explicitly attaches Connect to that exact saved identity. It does not modify an existing
host registration. `register` and `attach` are required explicit choices.

After proving stable attachment through MCP, the runner stops the connector and removes
the target's direct fallback from the runner's own disposable state. It retains the
attached Connect session and the same `environmentId`, then restarts the installed
connector before project and turn checks. `connect_only_access outcome=accepted` records
this preparation. This prevents healthy direct access from hiding a broken attached path.
Normal connector access selection and fallback remain available outside this isolated run.

The Connect runner performs:

1. `connect_authenticate`, print the public PKCE authorization URL, and poll `action=status`.
   Open the URL and complete browser login. The runner does not export or borrow credentials.
2. `list_connect_environments` and confirm that discovery leaves saved registrations unchanged.
3. Explicit registration or stable attachment of the turn target, then explicit registration of
   the operator-selected sanity environment. Confirm the exact saved registration set.
4. Project/start/read/continue/read on the chosen project and same thread. Acknowledgement
   alone is insufficient. Wait for the submitted message, a subsequent non-streaming assistant
   response, the acknowledged snapshot sequence, and completed status.
5. Restart the installed connector with the same smoke state and check saved project/thread access.
6. `sign_out_connect`, confirm signed-out status and discovery rejection, then verify unchanged
   registrations and valid project/thread access, including the sanity registration.
7. Authenticate again through a second explicit browser login. This permits an independent
   check that unregistration preserves the now-active account login.
8. `unregister_environment` for the turn target, restart, and confirm that its saved registration
   and project/thread access are gone. Verify the sanity registration still works, authentication
   is retained, and discovery still works. Discovery may still show the unregistered environment;
   local unregistration does not unlink it upstream.

## Results and evidence

Output contains only the public authorization URL and fixed summary codes. It excludes
grants, tokens, keys, endpoint metadata, labels, IDs, prompts, thread content, and raw errors.
`smoke_complete=true` and exit status 0 mean the selected sequence finished. A stopped,
blocked, partial, or unavailable run is not a pass. `accepted` reports a completed check;
dispatch checks still require later observation.

On `approval_required` or `input_required`, resolve the request in T3 Code. On an unknown
submission, inspect the smoke thread in T3 Code before deciding what to do. The runner
stops without replay or continuation and removes its temporary local state. Do not rerun
the script to retry an ambiguous mutation. `transport_error` indicates unreachable access;
`session_expired` indicates invalid environment authorization. Neither proves a Connect
login problem, and sign-out does not revoke an environment session.

Record date, package commit/artifact version, exact upstream commit, selected run mode,
safe summary codes, and exit status separately from credentials. The current evidence is:

| Evidence on 2026-09-30 | Status |
| --- | --- |
| Installed MCP/HTTP lifecycle and both packaged runners against strict signed-DPoP fixtures | Automated fixture evidence only |
| Attachment runner with Connect reads returning 503 and healthy direct access | Stops with `transport_error`; no completion claim or direct dispatch |
| Public relay authorization-server and protected-resource metadata | Unauthenticated HTTP 200; exact relay resource/token endpoint and ES256/DPoP declarations match |
| Real direct workflow | Not run in this process; no authorized endpoint/grant/project supplied |
| Real Connect registration and attachment workflows | Blocked before live execution; authorization handoff and operator resources unavailable |

Upstream pin is `7445aa733ada33e45289e5aa5055f79142556513`. The earlier inspected current
target is `c2fa9fc911daeac97df4760f95fc57dca42b84c8`; `main` resolved to
`35be904f2fc40aa6d7a42778b6895e8274f3097f` during #16 verification. The relay token exchange
handler and hosted authorize builder are identical at all three targets. This source/metadata
inspection is not a live authentication or turn pass. #15's local attachment fixes are implemented;
#16 and the supported-Connect gate remain incomplete.
