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

## Verification

The automated tests run an actual MCP client against the stdio connector and controlled HTTP
servers implementing this contract. They cover descriptor and token exchange, invalid grants,
restart persistence, failed replacement, two-environment registration isolation, malformed and
insecure URLs, redaction, owner-only storage, and redirect rejection.

A live direct-pairing smoke check against a real T3 environment without Connect is not recorded
in this repository: this workspace has no operator-provided environment endpoint and grant.
