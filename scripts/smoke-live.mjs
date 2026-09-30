#!/usr/bin/env node

import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

class SmokeFailure extends Error {}
const safeCodes = new Set([
  "invalid_input", "insecure_endpoint", "missing_grant", "upstream_incompatible",
  "pairing_rejected", "permission_denied", "session_expired", "project_not_found",
  "thread_not_found", "thread_busy", "approval_required", "input_required",
  "dispatch_conflict", "transport_error", "dispatch_failed", "unknown_outcome",
  "environment_exists", "environment_not_found", "environment_conflict",
  "connect_not_configured", "connect_auth_pending", "connect_auth_failed",
  "connect_auth_cancelled", "connect_auth_expired", "connect_account_conflict",
  "connect_permission_denied", "connect_unavailable", "connect_environment_not_found",
  "connect_identity_mismatch", "connect_endpoint_invalid", "storage_error", "internal_error",
]);
const safeCode = (code) => safeCodes.has(code) ? code : "tool_error";
function stop(code) {
  throw new SmokeFailure(code);
}
function requireThat(condition, code) {
  if (!condition) stop(code);
}
const setting = (name) => process.env[name]?.trim();
function required(name) {
  const value = setting(name);
  requireThat(value, `${name.toLowerCase()}_required`);
  return value;
}
function positive(name, fallback) {
  const value = setting(name) === undefined ? fallback : Number(setting(name));
  requireThat(Number.isSafeInteger(value) && value > 0, `${name.toLowerCase()}_invalid`);
  return value;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const accepted = (step) => console.log(`${step} outcome=accepted`);

async function pairingArguments() {
  const url = setting("T3_MCP_PAIRING_URL");
  if (url) return { pairingUrl: url };
  const file = setting("T3_MCP_PAIRING_FILE");
  if (file) {
    const text = (await readFile(file, "utf8")).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ");
    for (const match of text.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
      const candidate = match.replace(/[),.;\]}]+$/g, "");
      try {
        const parsed = new URL(candidate);
        if (parsed.searchParams.has("token") || new URLSearchParams(parsed.hash.slice(1)).has("token")) {
          return { pairingUrl: candidate };
        }
      } catch { /* Ignore unrelated text. Never rewrite the operator's endpoint. */ }
    }
    stop("pairing_url_not_found");
  }
  return { endpoint: required("T3_MCP_ENDPOINT"), grant: required("T3_MCP_GRANT") };
}

async function toolResult(client, name, args = {}) {
  try {
    const response = await client.callTool({ name, arguments: args });
    const value = response.structuredContent ?? JSON.parse(response.content?.[0]?.text ?? "null");
    requireThat(value && typeof value === "object", `${name}_invalid_response`);
    return response.isError || value.error ? { error: safeCode(value.error?.code) } : { value };
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    stop(`${name}_transport_failed`);
  }
}
async function call(client, name, args = {}) {
  const response = await toolResult(client, name, args);
  if (response.error) stop(response.error);
  return response.value;
}
async function expectError(client, name, args, code) {
  requireThat((await toolResult(client, name, args)).error === code, `${name}_expected_error_missing`);
}
async function authenticate(client, waitMs, pollMs) {
  let auth = (await call(client, "connect_authenticate")).authentication;
  if (auth?.status === "pending") {
    // The only non-summary output is the public PKCE browser URL returned by MCP.
    const url = new URL(auth.authorizationUrl);
    const expected = new URL(setting("T3_MCP_CONNECT_HOSTED_APP_URL") || "https://app.t3.codes");
    const fragment = new URLSearchParams(url.hash.slice(1));
    requireThat(url.origin === expected.origin && url.pathname === "/connect" && !url.username &&
      !url.password && !url.search && [...fragment.keys()].sort().join(",") === "challenge,port,state" &&
      /^[A-Za-z0-9_-]+$/.test(fragment.get("state")) && /^[A-Za-z0-9_-]+$/.test(fragment.get("challenge")) &&
      /^\d+$/.test(fragment.get("port")), "unsafe_authorization_url");
    console.log(`authorization_url=${url}`);
  }
  const deadline = Date.now() + waitMs;
  while (auth?.status === "pending") {
    requireThat(Date.now() < deadline, "authentication_timeout");
    await pause(pollMs);
    auth = (await call(client, "connect_authenticate", { action: "status" })).authentication;
  }
  if (auth?.error) stop(safeCode(auth.error.code));
  requireThat(auth?.status === "authenticated", "authentication_not_completed");
  accepted("authentication");
}
async function listedIds(client) {
  const entries = (await call(client, "list_environments")).environments;
  requireThat(Array.isArray(entries), "invalid_environment_list");
  return entries.map((entry) => entry.id).sort();
}
async function assertIds(client, expected) {
  requireThat(JSON.stringify(await listedIds(client)) === JSON.stringify([...expected].sort()), "registration_set_changed");
}
async function projects(client, environmentId, projectId) {
  const entries = (await call(client, "list_projects", { environmentId })).projects;
  requireThat(Array.isArray(entries) && entries.length > 0, "invalid_project_list");
  if (projectId) requireThat(entries.some((entry) => entry.id === projectId), "target_project_not_found");
}
async function settled(client, environmentId, threadId, waitMs, pollMs, submitted) {
  const deadline = Date.now() + waitMs;
  while (true) {
    const thread = (await call(client, "get_thread", { environmentId, threadId })).thread;
    requireThat(thread?.id === threadId, "thread_identity_changed");
    if (["approval_required", "input_required"].includes(thread.status)) stop(thread.status);
    const anchor = submitted && thread.messages?.findIndex((message) => message.role === "user" &&
      (submitted.messageId ? message.id === submitted.messageId : message.text === submitted.prompt));
    const observed = !submitted || (anchor >= 0 && thread.history?.snapshotSequence >= submitted.sequence &&
      thread.messages.slice(anchor + 1).some((message) => message.role === "assistant" && !message.streaming));
    if (thread.status === "completed" && observed) return;
    requireThat(["starting", "running", "completed"].includes(thread.status), "thread_not_completed");
    requireThat(Date.now() < deadline, "thread_timeout_unknown");
    await pause(pollMs);
  }
}
async function turns(client, environmentId, projectId, waitMs, pollMs) {
  await projects(client, environmentId, projectId);
  accepted("list_projects");
  const instance = setting("T3_MCP_MODEL_INSTANCE");
  const model = setting("T3_MCP_MODEL");
  requireThat(Boolean(instance) === Boolean(model), "model_selection_incomplete");
  const prompt = setting("T3_MCP_START_PROMPT") || "Reply with exactly: t3-mcp-smoke-start. Do not modify files or run commands.";
  const start = (await call(client, "start_turn", { environmentId, projectId,
    ...(model ? { modelSelection: { instanceId: instance, model } } : {}),
    prompt,
  })).start;
  requireThat(start?.outcome === "acknowledged", "start_turn_unknown_do_not_replay");
  requireThat(start.environmentId === environmentId && start.threadId, "invalid_start_identity");
  accepted("start_turn");
  await settled(client, environmentId, start.threadId, waitMs, pollMs, { prompt, sequence: start.turnSequence });
  accepted("get_thread_start");
  const continuation = (await call(client, "continue_turn", { environmentId, threadId: start.threadId,
    prompt: setting("T3_MCP_CONTINUE_PROMPT") || "Reply with exactly: t3-mcp-smoke-continue. Do not modify files or run commands.",
  })).continuation;
  requireThat(continuation?.outcome === "acknowledged", "continue_turn_unknown_do_not_replay");
  requireThat(continuation.threadId === start.threadId, "continuation_identity_changed");
  accepted("continue_turn");
  await settled(client, environmentId, start.threadId, waitMs, pollMs, { messageId: continuation.messageId, sequence: continuation.turnSequence });
  accepted("get_thread_continue");
  return start.threadId;
}

export async function runSmoke(mode = "direct") {
  let client;
  let directory;
  let completed = false;
  try {
    const environmentId = required("T3_MCP_ENVIRONMENT_ID");
    const projectId = required("T3_MCP_PROJECT_ID");
    const waitMs = positive("T3_MCP_WAIT_MS", 120_000);
    const authWaitMs = positive("T3_MCP_AUTH_WAIT_MS", 600_000);
    const pollMs = positive("T3_MCP_POLL_MS", 1_000);
    const action = mode === "connect" ? required("T3_MCP_CONNECT_ACTION") : "direct";
    const sanityId = mode === "connect" ? required("T3_MCP_SANITY_CONNECT_ENVIRONMENT_ID") : undefined;
    requireThat(mode !== "connect" || ["register", "attach"].includes(action), "connect_action_invalid");
    requireThat(sanityId !== environmentId, "sanity_identity_must_differ");
    const pairing = action === "attach" || mode === "direct" ? await pairingArguments() : undefined;
    // Always create fresh private state. Production state is never copied or opened.
    directory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-smoke-"));
    const env = { ...process.env, T3_MCP_STATE_DIR: directory };
    for (const name of Object.keys(env)) {
      if (name.startsWith("T3_MCP_") && !name.startsWith("T3_MCP_CONNECT_") &&
        !["T3_MCP_STATE_DIR", "T3_MCP_RELAY_CLIENT_ID"].includes(name)) delete env[name];
    }
    async function connect() {
      client = new Client({ name: "t3-mcp-operator-smoke", version: "1.0.0" });
      await client.connect(new StdioClientTransport({
        command: setting("T3_MCP_COMMAND") || "t3-mcp", args: [], env, stderr: "ignore",
      }));
    }
    await connect();
    await assertIds(client, []);
    if (pairing) {
      const paired = (await call(client, "add_environment", pairing)).environment;
      requireThat(paired?.id === environmentId, "paired_identity_mismatch");
      accepted("direct_pairing");
    }
    if (mode === "connect") {
      await authenticate(client, authWaitMs, pollMs);
      const before = await listedIds(client);
      const discovered = (await call(client, "list_connect_environments")).environments;
      requireThat(Array.isArray(discovered) && [environmentId, sanityId].every((id) => discovered.some((entry) => entry.id === id)), "explicit_connect_target_not_found");
      await assertIds(client, before);
      accepted("discovery_isolation");
      const selected = (await call(client, action === "attach" ? "attach_connect_environment" : "register_connect_environment", {
        environmentId, ...(action === "attach" ? { targetEnvironmentId: environmentId } : {}),
      })).environment;
      requireThat(selected?.id === environmentId && selected.source === "connect" &&
        (action !== "attach" || selected.connectAttached === true), "connect_identity_not_stable");
      accepted(action === "attach" ? "stable_attachment" : "explicit_registration");
      const sanity = (await call(client, "register_connect_environment", { environmentId: sanityId })).environment;
      requireThat(sanity?.id === sanityId, "sanity_identity_mismatch");
    }
    await assertIds(client, sanityId ? [environmentId, sanityId] : [environmentId]);
    accepted("list_environments");
    const threadId = await turns(client, environmentId, projectId, waitMs, pollMs);
    if (mode === "connect") {
      await client.close();
      await connect();
      await assertIds(client, [environmentId, sanityId]);
      await projects(client, environmentId, projectId);
      await settled(client, environmentId, threadId, waitMs, pollMs);
      accepted("restart_access");
      await call(client, "sign_out_connect");
      requireThat((await call(client, "connect_authenticate", { action: "status" })).authentication?.status === "signed_out", "signout_status_invalid");
      await expectError(client, "list_connect_environments", {}, "connect_auth_expired");
      await assertIds(client, [environmentId, sanityId]);
      await projects(client, environmentId, projectId);
      await settled(client, environmentId, threadId, waitMs, pollMs);
      await projects(client, sanityId);
      accepted("signout_access");
      // A second explicit browser login establishes the account-independence check.
      await authenticate(client, authWaitMs, pollMs);
      await call(client, "unregister_environment", { environmentId });
      await client.close();
      await connect();
      await assertIds(client, [sanityId]);
      await expectError(client, "list_projects", { environmentId }, "environment_not_found");
      await expectError(client, "get_thread", { environmentId, threadId }, "environment_not_found");
      await projects(client, sanityId);
      requireThat((await call(client, "connect_authenticate", { action: "status" })).authentication?.status === "authenticated", "unregister_cleared_account");
      await call(client, "list_connect_environments");
      accepted("unregister_restart");
    }
    completed = true;
  } catch (error) {
    console.error(`smoke_stopped reason=${error instanceof SmokeFailure ? error.message : "unexpected_failure"}`);
    process.exitCode = 1;
  } finally {
    if (client) await client.close().catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {
      console.error("smoke_stopped reason=state_cleanup_failed");
      process.exitCode = 1;
    });
  }
  if (completed && process.exitCode !== 1) console.log("smoke_complete=true");
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) await runSmoke();
