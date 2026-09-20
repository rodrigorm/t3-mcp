# Environment-owned authorization

Direct environment pairing is the required authorization path, independent of T3 Connect. Optional Connect support may provide remote connectivity later, but cannot replace environment authorization or become a prerequisite for direct use.

## Consequences

An operator supplies an environment-generated pairing URL or equivalent endpoint and grant. The connector exchanges it using the supported upstream protocol, retains only the session material needed for later access, and never returns credentials in tool results or diagnostics. Failed pairing must not replace an existing working registration; re-pairing explicitly targets the existing environment identifier.

The environment is the authorization boundary; projects are not filesystem sandboxes. Use only the required orchestration read/operate scopes, and do not silently fall back to administrative development credentials. Non-loopback direct connections require TLS. Store sessions outside the repository with owner-only access and atomic updates.

## Evidence and further notes

Upstream `pingdotgg/t3code` commit `7445aa733ada33e45289e5aa5055f79142556513`, inspected on 2026-09-20, documents environment-issued sessions, pairing scope restrictions, and separate Connect credentials in `docs/internals/environment-auth.md`. Exact exchange payloads, supported versions, expiry handling, and storage behavior on supported operating systems must be verified during the first implementation slice against a real environment. These are integration details, not a reconsideration of direct pairing.
