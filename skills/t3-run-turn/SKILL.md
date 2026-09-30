---
name: t3-run-turn
description: Run and observe T3 Code turns through t3-mcp, pair or attach an environment, and manage Connect sign-out or local unregistration.
---

# t3-run-turn

Use the `t3-mcp` MCP server for the complete workflow. Do not invoke a local turn CLI or assume a
private bot convention. Direct pairing is always available; T3 Connect is an optional operator-driven
path. Select the operator's exact environment and project; deployment-specific defaults are not
part of this skill.

Connect is EXPERIMENTAL and uses Desktop-native Clerk authentication. The operator enters
identifiers, passwords and verification codes only in the returned local browser page.
Keep credentials in the connector's private exchanges. On `upstream_incompatible`, report
the sanitized error and consult [the auth contract](../../docs/connect-auth-contract.md).

## Tools

The connector exposes the six direct workflow tools plus optional T3 Connect tools. Use their MCP
schemas as the source of truth.

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
- `connect_authenticate`: optional `action` of `start`, `status`, or `cancel`. Start the browser
  flow and complete it in the returned URL; credentials are never returned by the tool.
- `list_connect_environments`: no arguments. This discovers environments without saving or selecting
  one.
- `register_connect_environment`: `environmentId` and optional `label`. Explicitly save one discovered
  Connect environment.
- `attach_connect_environment`: `environmentId`, `targetEnvironmentId`, and optional `label`. Use
  this only to attach Connect access to an existing saved registration after identity matching.
- `sign_out_connect`: no arguments. This removes only Connect authentication; saved environment
  sessions remain available when valid.
- `unregister_environment`: `environmentId`. Remove one saved registration and its stored access
  paths.

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
but it is not a package dependency and is not part of this workflow. Connect discovery never implies
registration; select an environment explicitly, then register or attach it before using turn tools.

## Register or attach Connect access

1. For operator-requested Connect access, start `connect_authenticate`, have the operator open
   its loopback authorization URL on the connector host, and poll with `action=status` until
   `authenticated`. On failed or cancelled status, report the sanitized code and stop. Discovery
   and registration require authentication; an existing valid environment session does not.
2. Call `list_environments` and `list_connect_environments`. Discovery must leave saved
   registrations unchanged. Use only the operator's explicitly selected discovered `id`.
3. For a new registration, pass that `id` as `environmentId` to `register_connect_environment`.
   For operator-requested attachment to a saved registration, match its saved `id` to the
   discovered `id` exactly and call `attach_connect_environment` with that identity as both
   `environmentId` and `targetEnvironmentId`. Matching labels alone are insufficient. Omit
    `label` to preserve the saved label. Stop on identity, authorization or compatibility errors.
4. Confirm that `list_environments` contains one registration for that id with Connect access.
   For attachment, require `connectAttached: true` and an unchanged stable id. Use that same
   `environmentId` for project and turn tools. Attachment selects Connect access and retains
   the direct session, including older direct registrations.

## Repair direct access

Call `add_environment` with the saved `environmentId` and a fresh environment-issued pairing
grant. Success selects direct access and retains the attached Connect path. Failed attachment
or re-pairing preserves the previous registration. An identity or concurrent update conflict
requires selecting the current registration again before retrying.

Saved environment sessions survive restart and `sign_out_connect`. Use the existing project and
turn tools while a valid endpoint remains reachable. The connector can select a retained alternate
path during safe reads or mutation preflight; an `unknown` mutation still requires thread inspection.

## Sign out or forget an environment

For operator-requested sign-out, call `sign_out_connect`. Confirm registrations remain listed.
Use valid saved environment sessions while their endpoints are reachable. `transport_error`
means access could not be reached; `session_expired` means environment authorization is invalid.
Request Connect re-login only when Connect is needed for access.

For operator-requested removal, select the exact saved `id` and call `unregister_environment`
with that `environmentId`. Confirm it is absent from `list_environments`. Removal persists across
restart and removes all retained local direct/Connect access for that registration. Other
registrations and Connect login remain independent. Local removal does not revoke upstream
sessions or unlink the environment; discovery may still list it.

When asked to verify a deployment, follow [the installed-package smoke guide](../../docs/smoke-live.md).
Fixtures and public metadata are separate evidence from a real authorized workflow. A blocked or
partial run cannot establish supported Connect status.
