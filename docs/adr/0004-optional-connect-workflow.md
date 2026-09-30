# Optional Connect workflow

Status: Accepted in the issue #8 design interview.

Connect setup and authentication belong in the MCP host workflow through tools, with operator-driven login when requested. A separate mandatory `t3-mcp` CLI is not the setup path, and fully headless operation without a browser is outside the MVP. The workflow must remain host-independent; the operator's usual Desktop is an example deployment, not a package dependency.

Operators explicitly register or select each environment, using the same registered-environment model and `environmentId` targeting as direct pairing. Connect discovery must not automatically expose all account environments to project or turn tools. Authorization and continued operation during Connect failures follow ADR 0002.

## Registration identity and lifecycle

Prefer one stable registration and `environmentId` for direct pairing and Connect access when upstream identity proves they refer to the same environment. Attaching Connect as an access path requires explicit operator action. Never merge registrations solely by display name or label.

Connect sign-out clears the retained Connect login credentials but does not itself remove registrations or revoke or remove environment sessions. Existing tools may continue when the environment session is valid and its endpoint is reachable. Removing a saved environment requires explicit unregistration, which removes its locally retained access; this is separate from upstream session revocation.

The MVP supports one active Connect account. Account switching is deferred; any later switch must be explicit and must not automatically select or register environments from the new account.

## Compatibility claims

Connect remains optional and experimental until its upstream contract is verified and at least one real Connect smoke test passes. CI fixtures are acceptable evidence for automated behavior but cannot justify a supported or live-verified claim. README and compatibility documentation must reflect that status, using the same live-smoke bar as direct pairing.
