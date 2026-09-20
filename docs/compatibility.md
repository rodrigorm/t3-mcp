# Upstream Compatibility

The connector implements the direct environment contract evidenced by T3 Code commit
`7445aa733ada33e45289e5aa5055f79142556513`.

## Pairing Contract

1. Read `GET /.well-known/t3/environment` without credentials.
2. Require protocol version `1` (an omitted version means `1` in the upstream schema).
3. Exchange the operator's one-time grant at `POST /oauth/token` as
   `application/x-www-form-urlencoded` with:

   - `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
   - `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`
   - `requested_token_type=urn:ietf:params:oauth:token-type:access_token`
   - `scope=orchestration:read orchestration:operate`

4. Require a bearer access token and both orchestration scopes.
5. Validate the token with `GET /api/auth/session` and retain its reported expiry.

Pairing URLs may carry the one-time grant as exactly one `token` query parameter or as exactly one
`token` fragment parameter. Arbitrary query parameters are rejected, endpoint URLs supplied with an
explicit grant remain query-free, and accepted grants are stripped before any request is sent.

The upstream pairing grant is exchanged for a short-lived environment session. It is not
stored after the exchange. The bearer session is stored privately for later workflow slices.
DPoP is not requested because this connector does not implement DPoP proof keys.

## Orchestration Read Contract

1. Read `GET /api/orchestration/snapshot` with the saved bearer session and map active upstream
   projects' `id` and `title` to public `id` and `name` values.
2. Read `GET /api/orchestration/threads/:threadId` with `turnLimit` and optional `beforeCursor`
   query parameters. The upstream `page.beforeCursor` is returned as `nextCursor`; `hasMore` is
   also exposed as `truncated` so omitted history is explicit.
3. Map `latestTurn` and `session` states without treating unknown values as completed. Unresolved
   `approval.requested` activities produce `approval_required`; approval is handled in T3 Code.

Thread reads default to 20 user-anchored turns and accept at most 100 per request. Each request is
bounded by the connector's 10-second timeout and uses only the selected environment's session.

## First-Turn Dispatch Contract

`start_turn` first reads the selected environment's orchestration snapshot and requires the requested
active project. The project `defaultModelSelection` supplies the upstream `ModelSelection`. If the
project has no default, callers must provide the optional `modelSelection` input explicitly.

The connector then sends two authenticated JSON requests to `POST /api/orchestration/dispatch`:

1. `thread.create` with a connector-generated `threadId`, `commandId`, project id, `New thread` title,
   the selected model, `runtimeMode=full-access`, `interactionMode=default`, null branch/worktree,
   and an ISO creation time.
2. `thread.turn.start` with the same thread id, a user message containing the prompt and no attachments,
   `runtimeMode=full-access`, `interactionMode=default`, and an ISO creation time.

Each successful dispatch must return the upstream acknowledgement shape `{ "sequence": number }`.
The MCP result reports acknowledgement separately from completion and never fabricates a `turnId`.
If the first turn dispatch fails after creation, the result retains the thread id. Transport or invalid
acknowledgement failures are `unknown`; the connector never automatically replays either mutation.

## Continuation Dispatch Contract

`continue_turn` reads the selected thread to reject an already observed active, approval-blocked, or
input-blocked state. This read is advisory only: the connector still sends one authenticated
`thread.turn.start` command with the caller's thread id, a new command id, a new user message id,
the prompt, empty attachments, `runtimeMode=full-access`, `interactionMode=default`, and an ISO
creation time. It does not create a thread, fork the request, or submit an approval response.

The upstream dispatch result remains authoritative if the thread changes after observation. Known
busy, approval, authorization, missing-thread, and conflict responses become sanitized structured
errors. A lost or invalid acknowledgement is `unknown` with the thread, command, and message
identifiers; the connector never replays the command. The pinned upstream `thread.turn.start`
contract has no client precondition for an expected snapshot sequence, so two concurrent calls can
both pass the advisory read. An acknowledgement means acceptance only and does not promise
exactly-once execution or completion; the connector does not fabricate a precondition or silently
queue a call.

## Support statement

The supported upstream contract is T3 Code's direct environment and orchestration protocol version
`1`, evidenced by upstream commit `7445aa733ada33e45289e5aa5055f79142556513`. The automated fixture
advertises server version `0.0.42` and implements that contract; the public MCP tests exercise
pairing, discovery, dispatch, observation, pagination, authorization failures, and ambiguous
mutation outcomes against it. This is tested protocol compatibility, not a claim that the fixture's
server version is a currently deployed T3 release.

## Verification

The automated tests run an actual MCP client against the stdio connector and controlled HTTP
servers implementing this contract. They cover descriptor and token exchange, invalid grants,
restart persistence, failed replacement, two-environment registration isolation, project discovery,
thread status mapping, bounded pagination, first-turn and continuation acknowledgement/failure handling,
same-thread retrieval, malformed
and insecure URLs, redaction, owner-only storage on all supported platforms, and redirect rejection.

A live direct-pairing smoke check against a real T3 environment without Connect was not run for this
release because this workspace has no operator-provided environment endpoint and grant. No live
pair, list, start, retrieve, continue, retrieve result is claimed.
