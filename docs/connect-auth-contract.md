# Connect authentication through the official UI

Any method available in the official T3 Connect sign-in UI is valid for this connector.
The connector opens `https://app.t3.codes/` in a new, connector-owned headed browser
profile. Clerk's actual hosted UI and SDK handle providers, redirects, MFA, passkeys,
account verification and challenges. Node does not choose, implement or restrict factors.
Only the operator fills real sign-in inputs.

After the service activates a session, Node privately calls
`Clerk.session.getToken({ template: "t3-relay", skipCache: true })` in that browser.
The selected session's `user.id` pins the account. The JWT must match that account,
have the relay audience and usable expiry, and pass authenticated relay discovery
before MCP reports authenticated. Local claim inspection is not signature verification.

## Immutable source contract

| Source | Revision |
| --- | --- |
| T3 baseline | `d5980a0ff1511e6ae1f1876406a7c45a7a989cdb` |
| T3 comparison | `7445aa733ada33e45289e5aa5055f79142556513` |
| Clerk JavaScript / ClerkJS 6.32.1 | `ee1f90a65603db0673dbb0055c89ee820c4a64fa` |
| Clerk public OpenAPI / FAPI 2026-05-12 | `cdd59c4139088a7f733e7fdf2aa73eb74877d967` |

Primary sources:

- [Browser Clerk provider](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/web/src/components/clerk/BrowserManagedAuthShell.tsx),
  [ordinary T3 Connect sign-in action](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/web/src/components/clerk/useT3ConnectAuthPrompt.tsx).
- [Managed auth / template reader](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/web/src/cloud/managedAuth.tsx),
  [template options](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/packages/shared/src/relayAuth.ts),
  [public configuration](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/.env.example).
- [Public SDK session/token implementation](https://github.com/clerk/javascript/blob/ee1f90a65603db0673dbb0055c89ee820c4a64fa/packages/clerk-js/src/core/resources/Session.ts),
  [browser cookie refresh](https://github.com/clerk/javascript/blob/ee1f90a65603db0673dbb0055c89ee820c4a64fa/packages/clerk-js/src/core/auth/AuthCookieService.ts).
- [Public session-template endpoint contract](https://github.com/clerk/openapi-specs/blob/cdd59c4139088a7f733e7fdf2aa73eb74877d967/fapi/2026-05-12.yml#L2892-L2925).

The template and relay contracts agree at both T3 revisions. The implementation uses
the official hosted browser provider as its owned login provider, followed by the
same relay/environment HTTP DPoP sequence as Desktop. See
[registration contract](connect-registration-contract.md).

## Configuration and browser prerequisite

| Setting | Default |
| --- | --- |
| `T3_MCP_CONNECT_HOSTED_APP_URL` | `https://app.t3.codes/` |
| `T3_MCP_CONNECT_RELAY_URL` | `https://relay.t3.codes/` |
| `T3_MCP_CONNECT_CLERK_JWT_TEMPLATE` | `t3-relay` |
| `T3_MCP_CONNECT_BROWSER_EXECUTABLE` | Discover installed Google Chrome or Microsoft Edge |
| `T3_MCP_RELAY_CLIENT_ID` | `t3-web` |

Chrome/Edge discovery checks ordinary installation locations on macOS, Windows and
Linux. An explicit executable path can select another compatible Chromium installation.
Browser binaries are not downloaded, and the connector invokes no npm/auth/setup CLI.
Connect needs a browser and graphical desktop for operator login. Direct environment
tools work without a browser runtime. Missing/unusable executables return sanitized,
actionable errors without printing the configured path or subprocess diagnostics.

The hosted app configures Clerk itself. The connector needs no Clerk publishable key,
Client API credential, CLI OAuth client ID/token endpoint or custom callback scheme.
Hosted/relay overrides must be HTTPS or controlled loopback HTTP roots. A stored login
is associated with its exact hosted origin, relay and template configuration. Changed
configuration requires reauthentication instead of forwarding an existing session.

## Operator and private delivery

`connect_authenticate(start)` opens the headed browser and calls the public
`Clerk.openSignIn()` method after Clerk readiness. MCP returns only pending status,
the public hosted root, expiry, `browserOpened=true` and operator guidance.

Complete sign-in in the window opened by the connector. Opening the public URL in an
unrelated browser does not authenticate the connector's owned profile. Keep the owned
window open until `connect_authenticate(status)` reports authenticated. Closing it while
pending cancels completion. `action=cancel` stops pending work and removes that profile.

Browser control uses a private Playwright Core pipe. Node extracts only the selected
session/account association and a short-lived template JWT through the supported SDK.
It never reads/exports browser cookies or an installed Desktop/browser profile, or takes
over Desktop callback schemes. Passwords, codes and provider choices stay in the service
UI and never enter MCP arguments/results. Protocol debugging is disabled. There are no
console/network listeners, persistent traces, credential screenshots or token logging.

Provider redirects may navigate outside the app or open a popup. The service SDK handles
completion; Node reads tokens only on the configured hosted origin. A pending session/task
cannot complete authentication. Account/session changes while minting cannot save a grant.

## Persistence and lifecycle

The connector creates random-ID profiles beneath `connect-browser-profiles/` in its
private state directory. Profiles are newly owned by the connector, not attached to a
user's existing profile. Owner-only directories and a private creation umask protect
browser state. Profile-root symlinks and insecure permissions are rejected. Browser
cookies and their rotation/refresh remain entirely within Chrome/Edge and Clerk.
Ownership markers distinguish our profiles from unrelated files. Explicit sign-out
also removes interrupted owned profiles, with generation guards protecting a newer login.

`connect.json` version 3 stores the profile ID, selected session/account, configuration
association, Node-owned P-256 DPoP key, and cached template JWT/expiry. The profile and
credential store have one process owner. JSON writes are private and atomic, with CAS
snapshots, generation guards and restoration after cancellation races. Pending profiles
have separate IDs, so retired work cannot remove or overwrite a newer login.

Verified login closes the browser to flush its owned profile. Restart reopens that same
profile headlessly, reconstructs the service session and asks the SDK for a fresh token.
It verifies account ownership and relay discovery again. Cached templates honor their
actual `exp` with a five-second margin; concurrent renewal is deduplicated. Renewal does
not open an operator UI. Expiry/revocation or a service verification requirement needs
another explicit `start`, which opens a new headed login window. Account switching
requires explicit sign-out.

Sign-out clears the cached owned login, asks the SDK to end only its selected Clerk
session when reachable, and removes its profile. Cancellation/failed login removes only
the pending profile and preserves retained login state. Connector shutdown closes owned
browsers and retires pending saves. Environment sessions, registrations and their keys
are independent and remain usable when valid. Auth versions 1 and 2 migrate to
reauthentication-required state while preserving account pins and saved environment access.

## Evidence

Tests run actual MCP stdio and browser processes against controlled hosted app/Clerk,
external-provider, relay and environment HTTP. The service-page fixture owns its public
SDK, forms, provider redirect/MFA, HttpOnly cookies and session-template endpoint. It
does not mock connector/browser internals or inject a JWT through a connector shortcut.
The relay independently verifies issued JWT signatures/audience and strict DPoP proofs.

Coverage includes direct service sign-in, external provider/MFA, cookie rotations,
short-template renewal, same-profile restart, expired/revoked sessions, account conflicts,
secret reflection, process ownership, profile permissions, closed browser, cancellation,
actual atomic-write races, sign-out and independent environment lifecycle. Packed-package
tests retain full register/attach/project/start/read/continue/read and no-replay checks.

On 2026-09-30, an isolated headed browser at the real hosted root reached Clerk readiness
with no session and opened the official sign-in modal. Apple, GitHub, Google, Microsoft
and email controls were visible. No real identifier, password or verification was entered.
The actual stdio connector also opened a new owned headed profile at that production
root, reported `browserOpened=true`, remained pending/signed out, and cancelled cleanly.
This is signed-out UI evidence, not a production-authenticated smoke pass. The remaining
real account/machine/project checks are in [the operator smoke guide](smoke-live.md).

## Final review safeguards

- The credential owner holds an OS exclusive file lock through `fs-native-extensions`.
  Its lock inode is never unlinked or replaced, including after a crashed owner.
  Kernel lock release, not PID guessing, arbitrates current owners. A live legacy
  PID-only owner blocks upgrade; only an actual `ESRCH` permits that format's migration.
  The multiprocess MCP regression starts 16 contenders after killing the real prior
  owner, requires one winner and a stable inode, and verifies successor acquisition.
- Each browser opening returns an identity lease. Reads and cleanup require that
  lease, so a cancelled operation cannot close a new opening of the same retained profile.
  Registration also rereads the current template immediately before relay exchange,
  preserving its selected account, generation and DPoP key after slow discovery.
- Pending login observes public first/second `VerificationResource.status` and
  `error.code` fields. The immutable [verification types](https://github.com/clerk/javascript/blob/ee1f90a65603db0673dbb0055c89ee820c4a64fa/packages/shared/src/types/verification.ts#L7-L26)
  define `unverified`, `verified`, `transferable`, `failed` and `expired`.
  [Clerk error constants](https://github.com/clerk/javascript/blob/ee1f90a65603db0673dbb0055c89ee820c4a64fa/packages/shared/src/internal/clerk-js/constants.ts#L24-L55)
  define `oauth_access_denied`. Terminal denial/expiry and malformed SDK state fail
  safely, while retryable verification errors remain with the official UI. Error
  details, UI text and provider strategies are not exported or used to choose a method.
- [The pinned popup handler](https://github.com/clerk/javascript/blob/ee1f90a65603db0673dbb0055c89ee820c4a64fa/packages/clerk-js/src/utils/authenticateWithPopup.ts#L40-L80)
  checks callback origin, reloads the client and activates the returned session.
  Real-browser fixtures exercise `window.open`, external provider/MFA HTTP, callback
  `postMessage`, parent SDK rehydration, denial, popup closure/retry and cancellation.
- Playwright Core 1.63.0's client `BrowserContext.close()` returns immediately when
  the context is already marked closed. Chrome may still finish cache/metrics writes.
  Profile removal therefore uses bounded recursive removal retries for transient
  busy/not-empty races, after ownership validation. A real late-writer process
  reproduces this filesystem race; final permission and ownership errors still surface.
