# Desktop Connect authentication contract

The connector implements Desktop's native Clerk client lifecycle through the public
Frontend API. Node owns the Client API bearer credential and creates its own session.
The operator enters existing-account identifiers, passwords and verification codes in
a connector-owned loopback browser page. Node mints the session's `t3-relay` template
JWT and verifies it through authenticated relay discovery before reporting success.

The previous claim that an upstream JWT handoff was required was incorrect. Desktop
already uses this public session-template contract. CLI `/connect` authorization-code
OAuth is a different login flow and is no longer used by the connector.

## Immutable sources

Research baseline, inspected on 2026-09-30:

| Source | Revision |
| --- | --- |
| T3 current baseline | `d5980a0ff1511e6ae1f1876406a7c45a7a989cdb` |
| T3 comparison pin | `7445aa733ada33e45289e5aa5055f79142556513` |
| Clerk JavaScript, Electron 0.0.44 and ClerkJS 6.32.1 | `ee1f90a65603db0673dbb0055c89ee820c4a64fa` |
| Clerk public OpenAPI, FAPI version 2026-05-12 | `cdd59c4139088a7f733e7fdf2aa73eb74877d967` |

Relevant primary sources:

- [Desktop bridge and owned storage](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/desktop/src/app/DesktopClerk.ts),
  [Electron provider](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/web/src/components/clerk/ElectronManagedAuthShell.tsx),
  [ordinary sign-in action](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/web/src/components/clerk/useT3ConnectAuthPrompt.tsx).
- [Electron native request/rotation adapter](https://github.com/clerk/javascript/blob/ee1f90a65603db0673dbb0055c89ee820c4a64fa/packages/electron/src/react/create-clerk-instance.ts),
  [sign-in state machine](https://github.com/clerk/javascript/blob/ee1f90a65603db0673dbb0055c89ee820c4a64fa/packages/clerk-js/src/core/resources/SignIn.ts),
  [session/template implementation](https://github.com/clerk/javascript/blob/ee1f90a65603db0673dbb0055c89ee820c4a64fa/packages/clerk-js/src/core/resources/Session.ts).
- [Public Native Frontend API](https://github.com/clerk/openapi-specs/blob/cdd59c4139088a7f733e7fdf2aa73eb74877d967/fapi/2026-05-12.yml).
- [Production public defaults](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/.env.example),
  [template token options](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/packages/shared/src/relayAuth.ts),
  [managed auth](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/web/src/cloud/managedAuth.tsx).

These auth configurations and public contracts also apply at the comparison pin.
Current Desktop's added Codex/provider handoffs are unrelated to Clerk Connect login.

## Configuration

No configuration is required for the public T3 deployment:

| Setting | Default |
| --- | --- |
| `T3_MCP_CONNECT_CLERK_PUBLISHABLE_KEY` | `pk_live_Y2xlcmsudDMuY29kZXMk` |
| `T3_MCP_CONNECT_CLERK_JWT_TEMPLATE` | `t3-relay` |
| `T3_MCP_CONNECT_RELAY_URL` | `https://relay.t3.codes` |
| `T3_MCP_CONNECT_FRONTEND_API_URL` | Decoded publishable-key host, `https://clerk.t3.codes` |
| `T3_MCP_CONNECT_CALLBACK_PORT` | `0`, an OS-assigned loopback UI port |
| `T3_MCP_RELAY_CLIENT_ID` | `t3-web` |

The corresponding `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE` and
`T3CODE_RELAY_URL` aliases are accepted. Frontend API and relay overrides permit HTTPS
or controlled loopback HTTP. Stored credentials are associated with the exact Frontend
API, publishable key, template and relay configuration. Changed configuration requires
reauthentication, rather than forwarding an old credential to another endpoint.
CLI client IDs, OAuth token endpoints and hosted `/connect` settings are obsolete.

## Native transport and login

Every FAPI request appends `_is_native=1` and `__clerk_api_version=2026-05-12`, omits
cookies and Origin, and rejects redirects. Mutations use form encoding. Node sends
`Authorization: Bearer <nativeClientToken>` after client creation. Every response's
Authorization header, including error responses, rotates the private client credential
before the next request. Both raw and Bearer-prefixed response headers are supported.
The connector does not impersonate Electron, use a Clerk admin secret, borrow host
credentials, or register the installed Desktop's callback scheme.

The local browser URL is `http://127.0.0.1:<port>/login#<random-capability>`.
The page removes the capability from browser history and includes it in local form
POST bodies. The listener requires exact Host, same-origin POST, form content type,
one capability, bounded bodies and a current authorization generation. It uses no-store,
no-referrer and a nonce-based CSP with no external scripts or framing. Passwords/codes
never enter MCP inputs, results, diagnostics, URLs or persisted state.

| FAPI operation | Behavior |
| --- | --- |
| `POST /v1/client` | Create the connector's own native client. Privately stage its credential. |
| `POST /v1/client/sign_ins` | Identify the existing account; inspect actual status and factors. |
| `POST /v1/client/sign_ins/<id>/prepare_first_factor` | Prepare the offered email code using Clerk's returned email address ID. |
| `POST /v1/client/sign_ins/<id>/attempt_first_factor` | Submit the offered email code or password. |
| `prepare_second_factor` / `attempt_second_factor` on the same attempt | Complete offered second-factor or client-trust verification. |
| `GET /v1/client` and `GET /v1/client/sessions/<id>` | Prove one client-owned session, active status, usable expiry and matching user. |
| `POST /v1/client/sessions/<id>/touch` | Select that session with `intent=select_session` and recheck ownership. |
| `POST /v1/client/sessions/<id>/tokens/t3-relay` | Mint the actual relay JWT, separately from the Client API credential. |
| `GET <relay>/v1/environments` | Relay verifies that JWT; only then mark the login authenticated. |
| `POST /v1/client/sessions/<id>/end` | Best-effort, one-second bounded end of the owned session on explicit sign-out. |

HTTP 200 alone is never authentication evidence. A sign-in attempt must return
`status=complete` and its own `created_session_id`. Session tasks and Protect challenges
remain enforced. Template claim checks are compatibility checks; the relay independently
verifies signature and audience. An account may have zero environments.

## Factor coverage and recovery

The UI supports offered `email_code` and `password` first factors, plus offered `totp`,
`backup_code`, `phone_code` and `email_code` second factors. `needs_client_trust` follows
the same offered second-factor contract. Factors requiring delivery use the exact
Clerk-returned email/phone ID. Operator input cannot supply upstream factor or session IDs.

Production's public environment snapshot advertised Native API and email-code sign-in
enabled on 2026-09-30. An individual attempt's `supported_first_factors` and status still
decide what is available. Production availability is not proof of authenticated success.

Social/SSO-only attempts need a registered native redirect scheme, and passkeys need
an OS bridge. This UI reports those limitations and asks the operator to configure an
allowed email-code/password factor through T3 account settings. Unsupported second
factors, password reset, sign-up, pending session tasks, CAPTCHA and Protect challenges
receive specific recovery guidance. The connector neither bypasses them nor claims to
implement the full hosted Clerk UI.

## Persistence, renewal and lifecycle

`connect.json` version 2 stores the native client credential, selected session/account,
configuration association, P-256 DPoP key and cached template JWT/expiry. Pending native
credential rotations are staged privately in the same file. Passwords and codes stay
transient. State is plaintext with owner-only file/directory permissions, atomic writes
and a per-directory process owner lock. It is not Electron `safeStorage` encryption.

Requests serialize rotations. Store compare-and-swap snapshots and generation guards
prevent stale discovery failures or cancelled network/write completions from retiring
new credentials. One connector process owns each native credential state directory.
Restart rehydrates the client and verifies the selected session/account before renewing
through the template endpoint. The cached JWT honors its own `exp`, with a five-second
margin. There is no OAuth refresh token. Expired/revoked sessions require operator login.
The retained account remains pinned until explicit sign-out.

Cancellation/expiry discard pending native state and preserve the retained account login.
Sign-out clears owned login and attempts to end only its Clerk session. Registrations,
environment sessions and their proof keys are independent. Version 1 OAuth state migrates
to native reauthentication-required state, preserving its account pin and all separately
saved environment access. See [registration contract](connect-registration-contract.md).

Automated evidence uses actual MCP over stdio, controlled public FAPI/relay/environment
HTTP and local operator-form POSTs. It includes rotations, MFA/client trust, renewal,
restart, account conflict, reflection, sign-out and concurrent stale work. It is not
a live authenticated Clerk smoke. [Operator smoke prerequisites](smoke-live.md) are the
remaining real deployment verification.

The migrated write-race regressions also cancel over MCP after the OS observes creation
of a real atomic-write temporary file. Restart proves that the cancelled login stays
absent, or that the previously retained owned login survives recovery cancellation.

An isolated `agent-browser` check also exercised the rendered local form against controlled
HTTP: identifier, email-code view, password selection, required authenticator code and
verified completion. The URL fragment disappeared from browser history. Only fixture input
was entered; this browser check did not authenticate a production account.
