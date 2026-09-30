# Connect registration contract

Connect is optional and experimental. Desktop-native login obtains a real session-template
JWT through the public Clerk Frontend API. No upstream JWT handoff change is required.
See [authentication contract](connect-auth-contract.md) for immutable Clerk sources,
native factors, persistence and renewal.

## Immutable T3 sources

The baseline is `d5980a0ff1511e6ae1f1876406a7c45a7a989cdb`, compared with
`7445aa733ada33e45289e5aa5055f79142556513` on 2026-09-30. The relay JWT audience,
exchange fields and environment authorization sequence agree at both revisions.
Current relay code also includes tunnel recovery and replay pruning changes.

| Contract | Source at current baseline |
| --- | --- |
| Relay discovery, JWT verification and DPoP exchange | [relay HTTP API](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/infra/relay/src/http/Api.ts) |
| Desktop exchange fields and public `t3-web` client | [managed relay](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/packages/client-runtime/src/relay/managedRelay.ts), [Desktop layer](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/web/src/cloud/managedRelayLayer.ts) |
| Thirty-minute key-bound relay token | [relay tokens](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/infra/relay/src/auth/RelayTokens.ts) |
| Active account link, managed allocation and bootstrap brokering | [environment connector](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/infra/relay/src/environments/EnvironmentConnector.ts) |
| Identity-before-exchange and form fields | [authorization service](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/packages/client-runtime/src/authorization/service.ts), [remote exchange](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/packages/client-runtime/src/authorization/remote.ts) |
| Bound one-use bootstrap and environment sessions | [environment cloud HTTP](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/server/src/cloud/http.ts), [environment auth](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/server/src/auth/EnvironmentAuth.ts) |
| Proof validation and replay | [shared DPoP](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/packages/shared/src/dpop.ts), [environment verifier](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/server/src/auth/dpop.ts) |
| Orchestration HTTP | [environment HTTP contracts](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/packages/contracts/src/environmentHttp.ts) |

## Exchange sequence

1. Discover with `GET /v1/environments` and `Authorization: Bearer <t3-relay JWT>`.
   Discovery leaves registrations unchanged. The operator explicitly selects an identity.
2. Generate/persist a connector-owned P-256 key. POST a fresh DPoP proof to
   `<relay>/v1/client/dpop-token`, with form fields:

   ```text
   grant_type=urn:ietf:params:oauth:grant-type:token-exchange
   subject_token=<Clerk t3-relay template JWT>
   subject_token_type=urn:ietf:params:oauth:token-type:jwt
   requested_token_type=urn:ietf:params:oauth:token-type:access_token
   resource=https://relay.t3.codes
   scope=environment:connect
   client_id=t3-web
   ```

   The resource is the normalized relay issuer without a trailing slash. The proof's
   `htu` is the complete token endpoint. Require the access-token URN, `token_type=DPoP`,
   exact scope and integer lifetime no greater than 1800 seconds. The relay verifies the
   Clerk JWT signature, user `sub` and audience `t3-code-relay` without weakening checks.
3. POST `/v1/environments/<encoded-id>/connect` with that DPoP relay token, a fresh
   token-hash-bound proof and JSON `{ "clientProofKeyThumbprint": "<same jkt>" }`.
   The relay checks an active link and ready managed `cloudflare_tunnel` allocation.
   Validate returned ID, endpoint, unexpired one-use bootstrap and provider kind.
4. Fetch the selected environment's public descriptor and confirm its ID before
   sending any bootstrap credential. Exchange at `POST <environment>/oauth/token`
   with a fresh proof from the same key and:

   ```text
   grant_type=urn:ietf:params:oauth:grant-type:token-exchange
   subject_token=<one-use bootstrap credential>
   subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
   requested_token_type=urn:ietf:params:oauth:token-type:access_token
   scope=orchestration:read orchestration:operate
   ```

   There is no resource field. Require DPoP token type, only the requested scopes and
   integer lifetime no greater than 3600 seconds. Treat the token as opaque.
5. Verify `GET /api/auth/session` is authenticated with the DPoP method, both scopes
   and usable expiry. Persist the endpoint actually paired, its session and key.
6. Read projects/threads and dispatch over environment HTTP with that environment
   token and a new proof for every request. The browser only handles operator login.

Proofs require `typ=dpop+jwt`, ES256, public-only P-256 JWK, valid compact signature,
fresh unique `jti`, integer `iat`, exact uppercase method and normalized `htu` without
query/fragment. Protected requests include SHA-256 `ath` of the exact token. The verifier
allows at most 300 seconds of age and five seconds of future clock skew. Proofs are
never replayed; token exchanges use key possession without an access-token hash.

## Registration and lifecycle guards

Duplicate identity requires explicit attachment. Labels never merge registrations.
Attachment preserves the stable saved ID, label and direct session, including legacy
direct state. Direct repair selects direct access while retaining Connect access.
Failed or stale exchanges preserve the existing registration.

Sign-out removes only owned Clerk login state. Saved direct/Connect environment sessions
remain usable during Clerk expiry/revocation or relay outage when the environment is
reachable. Unregistration removes that environment's local access, without signing out
the account or unlinking the upstream machine.

Account/generation guards run after every network boundary and inside atomic registration
persistence. Compare-and-swap registration revisions prevent stale writes and resurrection
after removal. Independent identities commit without losing unrelated changes. Safe reads
and mutation preflight can use another retained path after transport failure or revoked
authorization. Once dispatch starts, it is sent once on that path. Unknown acknowledgements
are not replayed; partial starts preserve the created thread and command identifiers.

Public metadata and workflow results reject credential reflection, including either
attached path's tokens/private keys. Reflected identifiers fail instead of changing targets.

## Evidence

`test/support/connect-http.js` implements controlled public native Clerk endpoints with
single-use rotated Client API bearer credentials. Its relay independently verifies RS256
template signatures/audience, exact exchange fields and strict DPoP proofs. Its environment
consumes key-bound bootstrap grants and verifies opaque environment sessions and proofs.
Fixtures model ready managed endpoints using loopback HTTP, not deployed Cloudflare tunnels.

The public test boundary is actual MCP client, spawned stdio connector, controlled upstream
HTTP and operator-form local POSTs. Auth tests cover ownership, every header rotation,
supported factors/client trust, renewal without re-login, restart, expiry/revocation,
reflection, configuration association, migration and concurrent cancellation/stale 401s.
Registration/attachment tests preserve identity, CAS, fallback, no replay and full
project/start/read/continue/read regression coverage. The packed installed package exercises
both registration modes and shipped smoke runners, independent sign-out/unregistration,
unknown/blocked stops and stale-completion rejection. The attachment runner disables only
its disposable direct fallback so a healthy direct path cannot mask broken Connect access.

No operator-authenticated production login, template mint, managed environment connection
or live turn was performed in this implementation session. The remaining live check needs
an existing account with allowed factors, ready linked machines and an authorized project/model.
See [installed operator smoke instructions](smoke-live.md). Controlled tests and public
production metadata are separate evidence from a real authorized workflow.
