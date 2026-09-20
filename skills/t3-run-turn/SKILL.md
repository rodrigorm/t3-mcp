---
name: t3-run-turn
description: Run and observe T3 Code turns through the generic t3-mcp MCP tools.
---

# t3-run-turn

Use the `t3-mcp` MCP server for the complete workflow. Do not invoke a local turn CLI, assume a
private bot convention, or require T3 Connect.

## Tools

These are the six tools exposed by the connector. Use their MCP schemas as the source of truth.

- `add_environment`: `pairingUrl?`, `endpoint?`, `grant?`, `label?`, `environmentId?`. Provide a
  pairing URL or an endpoint; a pairing URL may carry its grant in the URL query or fragment, while
  an endpoint needs `grant` unless the grant is in the URL fragment.
  Set `environmentId` only when explicitly re-pairing a saved environment.
- `list_environments`: no arguments. Use the returned environment `id` for every environment,
  project, and thread operation.
- `list_projects`: `environmentId`.
- `start_turn`: `environmentId`, `projectId`, `prompt`, and optional `modelSelection` with
  `instanceId`, `model`, and optional `options` entries containing `id` and string-or-boolean
  `value`.
- `continue_turn`: `environmentId`, `threadId`, `prompt`.
- `get_thread`: `environmentId`, `threadId`, and optional `turnLimit` and `beforeCursor`.

## Run a turn

1. Call `list_environments`. If the target is not saved, call `add_environment` with the
   environment-generated pairing URL, or with its endpoint and grant.
2. Call `list_projects` for the selected environment and use a returned project `id`.
3. For new work, call `start_turn`. It creates a thread and returns an acknowledgement; it does
   not mean the turn is complete and it does not invent a `turnId`.
4. Call `get_thread` to observe the referenced thread. History is bounded: the default
   `turnLimit` is 20 and the maximum is 100. If `history.hasMore` or `history.truncated` is true,
   pass `history.nextCursor` as `beforeCursor` for the next bounded page.
5. For later work in the same conversation, wait for a settled thread and call `continue_turn`
   with that thread's exact `threadId`. Do not use `start_turn` to continue a thread. Active,
   approval-blocked, and input-blocked threads are not silently interrupted or queued.
6. For `approval_required` or `input_required`, have the user resolve the request in T3 Code,
   then call `get_thread` again. There is no approval tool in this connector.
7. If a mutation returns `unknown`, do not replay it. Call `get_thread` first and inspect the
   status, activities, messages, and available identifiers. Retry only after that inspection and a
   deliberate decision that the requested work was not accepted.

Normal adopted workflows use MCP for turns. A local turn CLI can be used by a host for debugging,
but it is not a package dependency and is not part of this workflow.
