# Optional T3 Connect authorization

T3 Connect is an optional operator-driven authorization path layered beside direct environment pairing. Connect discovery never registers an environment implicitly. The operator must explicitly register a new environment or attach Connect access to an existing registration after the environment identity matches.

## Consequences

Corrected on 2026-09-30: any method offered by the actual T3 Connect sign-in UI must work here. The connector owns a headed Chrome/Edge profile at the official hosted app and lets Clerk handle every provider, factor and challenge. Node privately obtains the `t3-relay` JWT through the supported SDK. This adds a browser runtime/profile dependency for Connect while preserving the service's full UI and avoiding installed Desktop callback conflicts. Direct environment tools remain browser-free.

Direct pairing remains usable without Connect. A saved environment may retain both direct and Connect access paths; sign-out clears only Connect authentication, while unregistration removes the saved environment and all stored access paths.

Connect environment access uses DPoP proofs and validates the selected environment identifier against both the relay response and the environment descriptor before persisting state. The relay is used for discovery and credential brokering, not as a replacement for the environment-issued session.

## Evidence and further notes

The template/relay contract agrees at T3 revisions `d5980a0ff1511e6ae1f1876406a7c45a7a989cdb` and `7445aa733ada33e45289e5aa5055f79142556513`. Immutable Clerk SDK/OpenAPI evidence and profile lifecycle guards are in [the auth contract](../connect-auth-contract.md). The actual official signed-out UI was observed; authenticated live verification still needs an operator and authorized machines/project.
