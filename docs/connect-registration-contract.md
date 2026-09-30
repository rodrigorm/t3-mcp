# Connect registration contract and blocker

Issue #14 implements the registration slice of spec #9 in PR #17. Connect remains
optional and experimental. The locally tested implementation does not complete
#14 or establish a live Connect workflow.

## Upstream evidence

Inspected on 2026-09-30 against `pingdotgg/t3code` at:

- Pinned target `7445aa733ada33e45289e5aa5055f79142556513`.
- Current `main` target `c2fa9fc911daeac97df4760f95fc57dca42b84c8`.

The `tokenApi` exchange handlers are identical at both commits. Current `main`
was resolved again through GitHub during this implementation.

| Contract | Immutable source at current target |
| --- | --- |
| JWT-only relay exchange, exact resource, allowed client scopes | [relay HTTP handler](https://github.com/pingdotgg/t3code/blob/c2fa9fc911daeac97df4760f95fc57dca42b84c8/infra/relay/src/http/Api.ts#L913-L973) |
| Hosted OAuth code callback, without a template-JWT handoff | [hosted authorize builder](https://github.com/pingdotgg/t3code/blob/c2fa9fc911daeac97df4760f95fc57dca42b84c8/apps/web/src/cloud/connectCliAuth.ts) |
| Official interactive client's session-template JWT | [managed auth provider](https://github.com/pingdotgg/t3code/blob/c2fa9fc911daeac97df4760f95fc57dca42b84c8/apps/web/src/cloud/managedAuth.tsx#L78-L82) |
| Thirty-minute key-bound relay session | [relay tokens](https://github.com/pingdotgg/t3code/blob/c2fa9fc911daeac97df4760f95fc57dca42b84c8/infra/relay/src/auth/RelayTokens.ts) |

Additional pinned contract sources are
[`EnvironmentConnector.ts`](https://github.com/pingdotgg/t3code/blob/7445aa733ada33e45289e5aa5055f79142556513/infra/relay/src/environments/EnvironmentConnector.ts),
[`dpop.ts`](https://github.com/pingdotgg/t3code/blob/7445aa733ada33e45289e5aa5055f79142556513/packages/shared/src/dpop.ts),
[`EnvironmentAuth.ts`](https://github.com/pingdotgg/t3code/blob/7445aa733ada33e45289e5aa5055f79142556513/apps/server/src/auth/EnvironmentAuth.ts),
and [`auth/http.ts`](https://github.com/pingdotgg/t3code/blob/7445aa733ada33e45289e5aa5055f79142556513/apps/server/src/auth/http.ts).

## Authentication blocker

Discovery can accept a Clerk OAuth bearer token. `POST /v1/client/dpop-token`
accepts only a verified JWT subject with a user `sub` and audience
`t3-code-relay`. The hosted `/connect` OAuth callback supplies a code for an
OAuth token exchange. It has no verified private delivery or renewal contract
for the official client's session-template JWT.

Opaque OAuth tokens and JWTs with a different audience cannot authorize this
registration flow. JWT shape and audience inspection in the connector only
detects incompatibility. It does not verify a signature or grant authorization;
the upstream relay must perform that verification.

The connector reports `upstream_incompatible` with sanitized direct-pairing
recovery instead of mislabeling this gap as expired login. A rejected relay
JWT/proof exchange also reports compatibility failure without returning its body.
OAuth login and discovery can remain usable after that failure.

Unblocking requires an upstream-owned, verified public-client authorization
contract that provides a relay-compatible subject or deliberately supports OAuth
subjects. Re-login, a custom client ID, or upgrading to the inspected current
upstream does not establish that contract. Administrative keys, host credentials,
browser token exports, invented conversion APIs, and weaker audience/proof checks
are not substitutes. Use independently authorized direct pairing meanwhile.

Production OAuth audience/format, redirect acceptance, operator account,
managed remote environment, and disposable project remain unverified. #16 owns
the authorized installed-package live smoke after this blocker is resolved.
The same authorization blocker applies to #15 attachment. The local legacy
direct-registration attachment migration fix is covered below.

## Implemented registration and session checks

- Send the relay resource as the normalized issuer origin without a trailing
  slash, separately from HTTP endpoint URL joining. Production resource is exactly
  `https://relay.t3.codes`. Request only `environment:connect` as `t3-web` or `t3-mobile`.
- Require a nonempty DPoP relay token, the access-token URN, the requested scope,
  and an integer lifetime of at most 1800 seconds.
- Connect only the explicitly selected identity. The relay authorizes the active
  link and ready `cloudflare_tunnel` allocation. Validate its returned endpoint,
  identity, and unexpired bootstrap. Check the environment descriptor identity
  before redeeming the one-use bootstrap.
- Exchange the bootstrap at that endpoint without a resource field. Request
  only `orchestration:read orchestration:operate`, require a DPoP response and a
  lifetime of at most 3600 seconds, then validate authenticated session state,
  method, required scopes, and expiry. Environment session tokens are opaque.
- Keep one P-256 proof key through relay, bootstrap, session validation, reads,
  and dispatch. Every request signs ES256 compact DPoP claims for method, URL
  without query/fragment, fresh `jti`, integer `iat`, and protected-token `ath`.
- Persist the endpoint actually paired, the environment session, and its key in
  owner-only atomic environment state. Bootstrap and relay tokens are transient.
  Restart preserves unrelated direct registrations. Duplicate identity needs
  explicit attachment; labels never merge registrations.
- Saved sessions work during relay outage, OAuth expiry, and connector sign-out
  while the environment remains reachable. Safe reads and mutation preflight may
  select another retained, unexpired path after transport failure or session
  revocation. Missing projects/threads, permission denial, malformed responses,
  and blocked states are not retried on another path. Once preflight selects a
  path, each dispatch is sent once. Lost acknowledgements remain unknown; partial
  starts retain the created thread and command identifiers.

## Fixture evidence and reuse

`test/support/connect-http.js` provides reusable controlled HTTP infrastructure:

- `startConnectControl` verifies RS256 fixture-issuer subjects and relay audience,
  exact resource and scopes, PKCE callback exchange, DPoP request binding/replay,
  and relay-to-bootstrap key continuity. It models a ready managed remote endpoint
  using local HTTP, not a deployed Cloudflare tunnel.
- `startConnectEnvironment` issues and consumes key-bound bootstrap grants,
  validates signed proofs and opaque environment sessions, and exposes controlled
  read/dispatch failures, revocation, and thread state.
- `fixture`, `login`, `call`, `success`, and `failure` launch the real stdio MCP
  process and manage isolated private state. `verifyDpop` independently verifies
  P-256 signature, public JWK, method, URL, time, `ath`, thumbprint, and replay.

`test/connect-registration.test.js` exercises registration, full turn workflow,
restart, isolation, lifecycle failures, malformed exchanges, identity rejection,
safe fallback, blocked continuation, and partial/unknown mutations.
`test/connect-http.test.js` sends deliberately invalid proofs and exchange fields
to prove that the fixture rejects them. `test/package.test.js` runs the same
workflow through the packed and installed package. Existing stdio and unregister
fixtures reuse the strict control plane and DPoP verifier.

`test/connect-attachment.test.js` covers #15 through the same real MCP client,
stdio process, and strict HTTP fixture. It seeds the supported pre-Connect
version-one state without access-path metadata and proves that attachment retains
the direct session through sign-out, restart, and fallback after Connect-session
revocation. It also exercises the full project/start/read/continue/read workflow,
same-label non-merge, missing/mismatched identity rejection before grant exchange,
failed attachment/re-pair preservation, successful direct repair retaining Connect,
and concurrent attachment/re-pair conflicts preserving the winning registration.
State remains owner-only, and completed writes leave no temporary files.

The packed-package test explicitly attaches to a direct registration and runs
project/start/read/continue/read through its Connect session after sign-out and
relay outage, alongside the new-registration workflow.

#16 can reuse the MCP sequence/assertions, but must replace controlled endpoints and
fixture-issued JWTs with the verified upstream authorization path. These tests
prove local connector behavior, not hosted OAuth JWT delivery, managed tunnel
provisioning, upstream broker proofs, or a live end-to-end pass.
