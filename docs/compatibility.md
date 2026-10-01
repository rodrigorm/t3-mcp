# Upstream compatibility

The connector implements the environment and Desktop Connect contracts evidenced by T3 Code
`d5980a0ff1511e6ae1f1876406a7c45a7a989cdb` and comparison pin
`7445aa733ada33e45289e5aa5055f79142556513`. Immutable Clerk/OpenAPI evidence is recorded in
[the Desktop authentication contract](connect-auth-contract.md).

## Pairing contract

1. Read `GET /.well-known/t3/environment` without credentials.
2. Require protocol version `1` (an omitted version means `1` in the upstream schema).
3. Exchange the operator's one-time grant at `POST /oauth/token` as
   `application/x-www-form-urlencoded` with:

   - `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
   - `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`
   - `requested_token_type=urn:ietf:params:oauth:token-type:access_token`
   - `scope=orchestration:read orchestration:operate`

4. Require a bearer access token and both orchestration scopes for direct pairing.
5. Validate the token with `GET /api/auth/session` and retain its reported expiry.

Pairing URLs may carry the one-time grant as exactly one `token` query parameter or as exactly one
`token` fragment parameter. Arbitrary query parameters are rejected, endpoint URLs supplied with an
explicit grant remain query-free, and accepted grants are stripped before any request is sent.

The upstream pairing grant is exchanged for a short-lived environment session. It is not stored after
the exchange. The bearer session is stored privately for later workflow slices.

## Experimental T3 Connect contract

Connect is optional and does not replace direct pairing. `connect_authenticate` returns a
public hosted root and opens its actual Clerk UI in an owned headed browser profile.
Any method offered there is valid. The operator alone handles providers, MFA, passkeys,
verification and challenges; the connector does not implement or filter factor strategies.

After authentication, `list_connect_environments` uses the Connect relay for discovery only. The
connector never saves a discovered environment implicitly. Node privately calls the supported
`Clerk.session.getToken({ template: "t3-relay", skipCache: true })` method in the owned
browser. Authentication completes after session/account checks and relay discovery succeed.
Owned browser cookies and the cached template JWT have separate lifecycles; restart reopens
only that private profile headlessly and renews through the SDK. See
[registration contract](connect-registration-contract.md).

After owned browser authentication, `register_connect_environment` or
`attach_connect_environment` explicitly selects an environment, requests a relay DPoP-bound credential,
and exchanges that credential at the environment's `/oauth/token` endpoint with a DPoP proof key.
Connect environment requests use the resulting DPoP access token and proof; direct environment requests
continue to use bearer access tokens.

The selected environment identifier is checked against both the relay response and the environment
descriptor before the bootstrap is redeemed. The endpoint actually paired is persisted.
Explicit attachment retains one stable registration and its direct session, including
pre-Connect version-one state without access-path metadata. Labels never merge identities.
Direct re-pairing checks the saved identity before grant exchange, selects the repaired direct
session, and retains any attached Connect access. Failed or stale exchanges preserve current access.
`sign_out_connect` clears only Connect authentication, while saved
environment sessions remain available when valid. `unregister_environment` removes the saved
environment and all of its stored access paths. Safe reads and mutation preflight may select an
alternate retained path after transport failure or revocation. Dispatch never switches paths or
replays after submission.

## Orchestration read contract

1. Read `GET /api/orchestration/snapshot` with the saved environment session and map active upstream
   projects' `id` and `title` to public `id` and `name` values.
2. Read `GET /api/orchestration/threads/:threadId` with `turnLimit` and optional `beforeCursor`
   query parameters. The upstream `page.beforeCursor` is returned as `nextCursor`; `hasMore` is
   also exposed as `truncated` so omitted history is explicit.
3. Map `latestTurn` and `session` states without treating unknown values as completed. Unresolved
   `approval.requested` activities produce `approval_required`; approval is handled in T3 Code.

Thread reads default to 20 user-anchored turns and accept at most 100 per request. Each request is
bounded by the connector's 10-second timeout and uses only the selected environment's session.

## First-turn dispatch contract

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

## Continuation dispatch contract

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

The implemented direct environment and orchestration contract is protocol version `1` at upstream
commits listed above. Connect is optional/experimental; the remaining real deployment check needs
operator-authorized resources. The automated fixtures advertise server version `0.0.42`;
the public MCP tests exercise pairing, Connect authentication and
discovery, explicit registration and attachment, sign-out, unregistration, dispatch, observation,
pagination, authorization failures, and ambiguous mutation outcomes. This is tested protocol
behavior, not a claim that the fixture's server version is a currently deployed T3 release or that
production Connect registration was exercised.

## Verification

The automated tests run an actual MCP client against the stdio connector and controlled HTTP
servers implementing the direct and Connect contracts. They cover descriptor and token exchange, invalid
grants, restart persistence, failed replacement, Connect discovery without implicit registration,
explicit registration and attachment, DPoP environment requests, sign-out, unregistration, two-environment
registration isolation, project discovery, thread status mapping, bounded pagination, first-turn and
continuation acknowledgement/failure handling, same-thread retrieval, malformed and insecure URLs,
redaction, owner-only storage on all supported platforms, and redirect rejection.

The Connect fixture checks exact normalized relay resource, subject JWT signature/audience, ready
managed-provider eligibility, DPoP signature/claims/token/key binding/replay, and one-use bootstrap
redemption. Attachment coverage includes legacy direct-session retention, same-label non-merge,
identity rejection before grant exchange, failed replacements, direct repair retaining Connect,
restart/sign-out/fallback, and concurrent updates. The packed package also runs
project/start/read/continue/read for explicit registration and attachment against this controlled
contract. It also rejects the removed registration across restart without upstream requests to
either former endpoint, verifies another registration's usability, and checks retained Connect
login/discovery. The packaged generic direct
and Connect runners use that same installed MCP/HTTP boundary. Runner tests cover explicit targets,
both registration modes, lifecycle checks, blocked/unknown stops without replay, stale-completion
rejection, redacted summaries, and isolation from existing state. Actual-browser auth coverage
includes external provider/MFA and direct service UI, cookie rotation, short-template renewal,
account pinning, revoked sessions, secret reflection, same-profile restart, process ownership,
profile/config association, old-auth migration, closed browsers, interrupted profile cleanup
and concurrent cancellation/CAS/atomic-write races.
Fixture success does not complete the real operator smoke.

Unauthenticated production relay metadata returned HTTP 200 on 2026-09-30 and matched the exact
relay issuer/resource, token endpoint, and ES256/DPoP declarations. No credentialed request or
live login, registration, attachment, or turn was attempted. The earlier claim that Desktop
login needs upstream authorization changes was incorrect. The official hosted Clerk UI and
public session-template SDK provide that login. Connect stays EXPERIMENTAL and the real
operator smoke remains unperformed. See [repeatable smoke instructions](smoke-live.md).

A live direct-pairing or Connect smoke check against a real T3 environment was not run for this release
because this workspace has no operator-authorized environment endpoint, grant, or Connect account. No
live pair, Connect registration, list, start, retrieve, continue, or retrieve result is claimed.
