# Optional T3 Connect authorization

T3 Connect is an optional operator-driven authorization path layered beside direct environment pairing. Connect discovery never registers an environment implicitly. The operator must explicitly register a new environment or attach Connect access to an existing registration after the environment identity matches.

## Consequences

Corrected on 2026-09-30: Connect authentication reproduces Desktop's public native Clerk Client API lifecycle. Node owns a new client/session and mints the `t3-relay` template JWT; the operator enters existing-account factors in a connector-owned loopback page. This avoids an ongoing browser profile dependency and installed Desktop callback conflicts. Connect credentials and the DPoP private key remain in separate owner-only atomic state from environment registrations.

Direct pairing remains usable without Connect. A saved environment may retain both direct and Connect access paths; sign-out clears only Connect authentication, while unregistration removes the saved environment and all stored access paths.

Connect environment access uses DPoP proofs and validates the selected environment identifier against both the relay response and the environment descriptor before persisting state. The relay is used for discovery and credential brokering, not as a replacement for the environment-issued session.

## Evidence and further notes

The Desktop auth contract agrees at T3 revisions `d5980a0ff1511e6ae1f1876406a7c45a7a989cdb` and `7445aa733ada33e45289e5aa5055f79142556513`. Clerk's public native/session-template APIs supply the required relay subject; the earlier upstream-handoff blocker claim was incorrect. Exact immutable Clerk/OpenAPI sources and supported-factor limits are in [the auth contract](../connect-auth-contract.md). Live verification still needs operator-authorized login and environments.
