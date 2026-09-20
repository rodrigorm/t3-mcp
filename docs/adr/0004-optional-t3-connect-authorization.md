# Optional T3 Connect authorization

T3 Connect is an optional operator-driven authorization path layered beside direct environment pairing. Connect discovery never registers an environment implicitly. The operator must explicitly register a new environment or attach Connect access to an existing registration after the environment identity matches.

## Consequences

Connect authentication uses browser OAuth with PKCE through a loopback callback. Connect credentials and the DPoP private key are stored in a separate owner-only state file from environment registrations. Relay and environment access tokens are never returned in MCP results or diagnostics.

Direct pairing remains usable without Connect. A saved environment may retain both direct and Connect access paths; sign-out clears only Connect authentication, while unregistration removes the saved environment and all stored access paths.

Connect environment access uses DPoP proofs and validates the selected environment identifier against both the relay response and the environment descriptor before persisting state. The relay is used for discovery and credential brokering, not as a replacement for the environment-issued session.

## Evidence and further notes

The upstream `pingdotgg/t3code` commit `7445aa733ada33e45289e5aa5055f79142556513`, inspected on 2026-09-20, documents the Connect OAuth, relay, DPoP, and environment-authentication boundaries. The automated fixture covers the public MCP lifecycle; live Connect verification still requires an operator-authorized account and environment.
