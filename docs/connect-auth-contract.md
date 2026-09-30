# Connect authentication contract

Verified before the #12 changes against `pingdotgg/t3code` commit
`7445aa733ada33e45289e5aa5055f79142556513` on 2026-09-30.

## Source evidence

- `packages/shared/src/connectAuth.ts` builds the hosted `/connect` URL with
  `state`, SHA-256 PKCE `challenge`, and loopback `port` in its fragment.
- `apps/web/src/cloud/connectCliAuth.ts` forwards to Clerk OAuth authorization
  with `response_type=code`, `code_challenge_method=S256`, and scopes
  `openid profile email offline_access`. Clerk redirects directly to
  `http://127.0.0.1:<port>/callback`.
- `apps/server/src/cloud/publicConfig.ts` and `docs/operations/connect-setup.md`
  specify loopback port `34338` and the corresponding OAuth redirect allowlist entry.
- `apps/server/src/cloud/CliTokenManager.ts` exchanges the code using a form POST
  containing `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`,
  and `code_verifier`. Refresh uses `grant_type=refresh_token`, `refresh_token`,
  and `client_id`. Responses contain `access_token`, `token_type`, `expires_in`,
  and optional `refresh_token` and `id_token`. Omitted refresh tokens retain the
  previous refresh token. Browser authorization expires after ten minutes.
- `packages/contracts/src/relay.ts` defines bearer-authenticated
  `GET /v1/environments` with an `environments` array. Each record contains
  `environmentId`, `label`, `linkedAt`, and an endpoint with `httpBaseUrl`,
  `wsBaseUrl`, and provider `manual`, `cloudflare_tunnel`, or `t3_relay`.
- `packages/client-runtime/src/relay/discovery.ts` reads the Clerk JWT `sub` as
  the account identity and discards discovery work from an earlier account generation.

Source paths above are relative to the pinned upstream tree, available at
`https://github.com/pingdotgg/t3code/tree/7445aa733ada33e45289e5aa5055f79142556513`.

## Connector behavior

Connect remains optional and experimental. Start with `connect_authenticate`,
open its public authorization URL on the connector's host, and poll with
`action=status`. Use `action=cancel` to stop pending authorization. On expired
or rejected credentials, start authentication again. A retained account is pinned
until `sign_out_connect`; authenticating as another account requires sign-out first.
Account comparison uses token subjects received from the configured TLS token endpoint;
decoding a subject locally is not independent JWT signature verification.

The callback defaults to upstream's documented port `34338`.
`T3_MCP_CONNECT_CALLBACK_PORT` can select another port, or `0` for an OS-assigned
port, only when the chosen OAuth application's redirect policy permits it.
The hosted page's OAuth client/issuer configuration must match the connector's
code-exchange configuration. Production redirect acceptance remains a live-smoke item.

Discovery does not register environments. Sign-out clears Connect credentials
separately from saved environment sessions. Existing direct sessions remain usable
when their endpoints are reachable and their environment authorization is valid.

The automated auth tests use a real MCP client, stdio process, and controlled
HTTP endpoints. They are fixture evidence, not a live Clerk or Connect smoke.
Real verification still needs an operator-authorized account and reachable environment,
tracked by #16. Relay DPoP registration belongs to #14.

## Registration compatibility blocker

The pinned relay permits Clerk OAuth bearer tokens for discovery, but its DPoP
bootstrap exchange requires a Clerk JWT with the relay's audience. The hosted CLI
OAuth flow does not establish a verified path to that JWT. An opaque OAuth token,
or a JWT with a different audience, cannot be assumed to authorize registration.
The official web/mobile clients obtain a Clerk session-template JWT instead.
This is a #14 compatibility blocker, not a reason to substitute credentials or
change the login/discovery contract. See the pinned relay HTTP implementation
in `infra/relay/src/http/Api.ts` and the web client in
`apps/web/src/cloud/managedAuth.tsx`. The same JWT-only exchange remains at current
`main` commit `c2fa9fc911daeac97df4760f95fc57dca42b84c8`.
See [registration contract and blocker](connect-registration-contract.md) for
the compatibility guard, local fixture evidence, and remaining upstream work.
