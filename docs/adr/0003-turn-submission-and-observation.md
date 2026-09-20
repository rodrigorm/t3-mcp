# Separate turn submission from observation

`start_turn` creates a thread in an explicitly selected environment and project and submits its first turn; `continue_turn` submits a new turn to an explicitly selected existing thread. Both return after command acknowledgement rather than waiting for agent completion, and `get_thread` observes subsequent progress, because agent execution can outlive an MCP request.

## Consequences

Results distinguish command acceptance from execution completion and carry available environment, project, thread, and command identifiers. The connector does not automatically replay a mutation after an ambiguous timeout; it reports an unknown outcome and identifiers for inspection. If thread creation succeeds but first-turn submission fails, return the existing thread identifier rather than silently creating another thread.

An active or approval-blocked thread must not be silently interrupted, queued, or approved by continuation. Report the upstream state and direct the user to T3 Code for approvals. Thread retrieval exposes bounded history, explicit truncation, and supported pagination rather than presenting a partial response as complete.

## Evidence and further notes

The upstream orchestration HTTP handlers at commit `7445aa733ada33e45289e5aa5055f79142556513` expose project read models, paginated thread snapshots, and command dispatch with separate read/operate permissions. Exact command identifiers, concurrency guarantees, status mappings, and provider/model defaults require contract verification during implementation. Do not promise exactly-once submission beyond upstream guarantees.
