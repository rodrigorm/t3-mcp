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

## Verification

The automated tests run an actual MCP client against the stdio connector and controlled HTTP
servers implementing this contract. They cover descriptor and token exchange, invalid grants,
restart persistence, failed replacement, two-environment registration isolation, project discovery,
thread status mapping, bounded pagination, malformed and insecure URLs, redaction, owner-only
storage, and redirect rejection.

A live direct-pairing smoke check against a real T3 environment without Connect is not recorded
in this repository: this workspace has no operator-provided environment endpoint and grant.
