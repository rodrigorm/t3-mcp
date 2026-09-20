#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultStateDirectory = "/tmp/t3-mcp-smoke-state";
const defaultLoopbackEndpoint = "http://127.0.0.1:3773";
const defaultProjectId = "f4d5edfb-adbb-48c4-8e45-7afdb69f1aca";
const defaultModelInstance = "opencode";
const defaultModel = "openai/gpt-5.6-luna";
const defaultWaitMs = 120_000;
const defaultPollMs = 1_000;

class SmokeFailure extends Error {}

function failure(message) {
  throw new SmokeFailure(message);
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) failure(`${name}_invalid`);
  return parsed;
}

function pairingUrlFromText(value) {
  const withoutAnsi = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ");
  for (const match of withoutAnsi.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    const candidate = match.replace(/[),.;\]}]+$/g, "");
    try {
      const url = new URL(candidate);
      const fragment = new URLSearchParams(url.hash.slice(1));
      if (url.searchParams.has("token") || fragment.has("token")) return candidate;
    } catch {
      // Ignore QR formatting and unrelated URLs in the CLI output.
    }
  }
  return undefined;
}

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function pairingArgumentsFromUrl(pairingUrl, allowLocalLoopbackFallback = false) {
  const url = new URL(pairingUrl);
  if (allowLocalLoopbackFallback && url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    const grant = url.searchParams.get("token") || fragment.get("token");
    if (!grant) failure("pairing_grant_not_found");
    return {
      endpoint: process.env.T3_MCP_LOOPBACK_ENDPOINT?.trim() || defaultLoopbackEndpoint,
      grant,
    };
  }
  return { pairingUrl };
}

async function pairingArguments() {
  const pairingUrl = process.env.T3_MCP_PAIRING_URL?.trim();
  if (pairingUrl) return pairingArgumentsFromUrl(pairingUrl);

  const pairingFile = process.env.T3_MCP_PAIRING_FILE?.trim();
  if (pairingFile) {
    const fromFile = pairingUrlFromText(await readFile(pairingFile, "utf8"));
    if (!fromFile) failure("pairing_url_not_found");
    return pairingArgumentsFromUrl(fromFile, true);
  }

  const endpoint = process.env.T3_MCP_ENDPOINT?.trim();
  const grant = process.env.T3_MCP_GRANT?.trim();
  if (endpoint && grant) return { endpoint, grant };
  failure("set_pairing_url_or_endpoint_and_grant");
}

function parseToolResult(result, toolName) {
  let value = result.structuredContent;
  if (value === undefined) {
    try {
      value = JSON.parse(result.content?.[0]?.text ?? "{}");
    } catch {
      failure(`${toolName}_invalid_response`);
    }
  }
  if (!value || typeof value !== "object") failure(`${toolName}_invalid_response`);

  const error = value.error;
  if (result.isError || (error && typeof error === "object")) {
    return {
      error: {
        code: typeof error?.code === "string" ? error.code : "tool_error",
      },
    };
  }
  return { value };
}

async function callTool(client, toolName, arguments_) {
  try {
    return parseToolResult(await client.callTool({ name: toolName, arguments: arguments_ }), toolName);
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    failure(`${toolName}_transport_failed`);
  }
}

function errorOutcome(error) {
  return error?.code === "approval_required" || error?.code === "input_required"
    ? "approval_required"
    : "unknown";
}

function printOutcome(step, outcome, fields = {}) {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(`[${step}] outcome=${outcome}${suffix ? ` ${suffix}` : ""}`);
}

async function readThread(client, environmentId, threadId, step) {
  const result = await callTool(client, "get_thread", { environmentId, threadId });
  if (result.error) {
    const outcome = errorOutcome(result.error);
    printOutcome(step, outcome, { errorCode: result.error.code });
    return { outcome, error: result.error };
  }

  const thread = result.value.thread;
  if (!thread || typeof thread.status !== "string") {
    printOutcome(step, "unknown", { errorCode: "invalid_thread" });
    return { outcome: "unknown", error: { code: "invalid_thread" } };
  }

  const outcome =
    thread.status === "approval_required" || thread.status === "input_required"
      ? "approval_required"
      : thread.status === "unknown" || thread.status === "error"
        ? "unknown"
        : "accepted";
  printOutcome(step, outcome, { status: thread.status });
  return { outcome, thread };
}

async function waitForSettledThread(client, environmentId, threadId, observation, step, waitMs, pollMs) {
  let current = observation;
  const deadline = Date.now() + waitMs;
  while (current.thread && ["starting", "running"].includes(current.thread.status)) {
    if (Date.now() >= deadline) {
      printOutcome(`${step}.timeout`, "unknown", { errorCode: "thread_still_active" });
      return { outcome: "unknown", error: { code: "thread_still_active" } };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    current = await readThread(client, environmentId, threadId, `${step}.wait`);
    if (current.outcome !== "accepted") return current;
  }
  return current;
}

async function main() {
  const stateDirectory = process.env.T3_MCP_STATE_DIR?.trim() || defaultStateDirectory;
  const waitMs = parsePositiveInteger(process.env.T3_MCP_WAIT_MS, defaultWaitMs, "wait_ms");
  const pollMs = parsePositiveInteger(process.env.T3_MCP_POLL_MS, defaultPollMs, "poll_ms");
  const targetProjectId = process.env.T3_MCP_PROJECT_ID?.trim() || defaultProjectId;
  const targetEnvironmentId = process.env.T3_MCP_ENVIRONMENT_ID?.trim();
  const repairEnvironmentId = process.env.T3_MCP_REPAIR_ENVIRONMENT_ID?.trim();
  const modelSelection = {
    instanceId: process.env.T3_MCP_MODEL_INSTANCE?.trim() || defaultModelInstance,
    model: process.env.T3_MCP_MODEL?.trim() || defaultModel,
  };

  const childEnvironment = { ...process.env, T3_MCP_STATE_DIR: stateDirectory };
  for (const name of [
    "T3_MCP_PAIRING_URL",
    "T3_MCP_PAIRING_FILE",
    "T3_MCP_ENDPOINT",
    "T3_MCP_GRANT",
  ]) {
    delete childEnvironment[name];
  }

  const transport = new StdioClientTransport({
    command: process.env.T3_MCP_COMMAND?.trim() || "t3-mcp",
    args: [],
    cwd: repositoryRoot,
    env: childEnvironment,
    stderr: "ignore",
  });
  const client = new Client({ name: "t3-mcp-live-smoke", version: "1.0.0" });

  console.log(`state_dir=${stateDirectory}`);
  try {
    await client.connect(transport);
    const added = await callTool(client, "add_environment", {
      ...(await pairingArguments()),
      label: "t3-mcp live smoke",
      ...(repairEnvironmentId ? { environmentId: repairEnvironmentId } : {}),
    });
    if (added.error) {
      printOutcome("1 add_environment", errorOutcome(added.error), { errorCode: added.error.code });
      failure("add_environment_not_accepted");
    }
    const addedEnvironment = added.value.environment;
    if (!addedEnvironment?.id) failure("add_environment_invalid_response");
    printOutcome("1 add_environment", "accepted", { environmentId: addedEnvironment.id });

    const listed = await callTool(client, "list_environments", {});
    if (listed.error) {
      printOutcome("2 list_environments", errorOutcome(listed.error), { errorCode: listed.error.code });
      failure("list_environments_failed");
    }
    const environments = listed.value.environments;
    if (!Array.isArray(environments) || environments.length === 0) {
      printOutcome("2 list_environments", "unknown", { errorCode: "no_environments" });
      failure("list_environments_invalid_response");
    }
    printOutcome("2 list_environments", "accepted", { count: environments.length });

    const candidates = targetEnvironmentId
      ? environments.filter((environment) => environment.id === targetEnvironmentId)
      : environments;
    if (candidates.length === 0) failure("environment_not_found_in_list");

    let selectedEnvironment;
    let selectedProjects;
    for (const environment of candidates) {
      const projectsResult = await callTool(client, "list_projects", { environmentId: environment.id });
      if (projectsResult.error) {
        if (targetEnvironmentId) {
          printOutcome("3 list_projects", errorOutcome(projectsResult.error), {
            errorCode: projectsResult.error.code,
          });
          failure("list_projects_failed");
        }
        continue;
      }
      const projects = projectsResult.value.projects;
      if (!Array.isArray(projects)) continue;
      if (projects.some((project) => project?.id === targetProjectId)) {
        selectedEnvironment = environment;
        selectedProjects = projects;
        break;
      }
    }
    if (!selectedEnvironment) {
      printOutcome("3 list_projects", "unknown", { errorCode: "target_project_not_found" });
      failure("target_project_not_found");
    }
    printOutcome("3 list_projects", "accepted", {
      environmentId: selectedEnvironment.id,
      projectCount: selectedProjects.length,
      projectId: targetProjectId,
    });

    const started = await callTool(client, "start_turn", {
      environmentId: selectedEnvironment.id,
      projectId: targetProjectId,
      modelSelection,
      prompt:
        process.env.T3_MCP_START_PROMPT?.trim() ||
        "For this smoke check, reply with exactly: t3-mcp-live-smoke-start-accepted",
    });
    if (started.error) {
      printOutcome("4 start_turn", errorOutcome(started.error), { errorCode: started.error.code });
      failure("start_turn_not_accepted");
    }
    const start = started.value.start;
    if (!start?.threadId) {
      printOutcome("4 start_turn", "unknown", { errorCode: "invalid_start_response" });
      failure("start_turn_invalid_response");
    }
    const startOutcome = start.outcome === "acknowledged" ? "accepted" : "unknown";
    printOutcome("4 start_turn", startOutcome, { threadId: start.threadId });

    let observation = await readThread(client, selectedEnvironment.id, start.threadId, "5 get_thread");
    if (startOutcome !== "accepted") failure("start_turn_unknown_do_not_replay");
    if (observation.outcome !== "accepted") failure("initial_thread_observation_requires_inspection");
    observation = await waitForSettledThread(
      client,
      selectedEnvironment.id,
      start.threadId,
      observation,
      "5 get_thread",
      waitMs,
      pollMs,
    );
    if (observation.outcome !== "accepted" || !observation.thread) {
      failure("initial_thread_not_safe_to_continue");
    }
    if (!["completed", "idle", "interrupted"].includes(observation.thread.status)) {
      failure("initial_thread_not_settled");
    }

    const continued = await callTool(client, "continue_turn", {
      environmentId: selectedEnvironment.id,
      threadId: start.threadId,
      prompt:
        process.env.T3_MCP_CONTINUE_PROMPT?.trim() ||
        "For this smoke check, reply with exactly: t3-mcp-live-smoke-continue-accepted",
    });
    if (continued.error) {
      printOutcome("6 continue_turn", errorOutcome(continued.error), { errorCode: continued.error.code });
    } else if (continued.value.continuation?.outcome === "acknowledged") {
      printOutcome("6 continue_turn", "accepted", { threadId: start.threadId });
    } else {
      printOutcome("6 continue_turn", "unknown", { errorCode: "unknown_outcome" });
    }

    const finalObservation = await readThread(client, selectedEnvironment.id, start.threadId, "7 get_thread");
    const settledFinalObservation =
      finalObservation.outcome === "accepted" && finalObservation.thread
        ? await waitForSettledThread(
            client,
            selectedEnvironment.id,
            start.threadId,
            finalObservation,
            "7 get_thread",
            waitMs,
            pollMs,
          )
        : finalObservation;
    if (continued.error || continued.value.continuation?.outcome !== "acknowledged") {
      failure("continuation_unknown_do_not_replay");
    }
    if (settledFinalObservation.outcome !== "accepted" || !settledFinalObservation.thread) {
      failure("final_thread_observation_requires_inspection");
    }
    if (!["completed", "idle", "interrupted"].includes(settledFinalObservation.thread.status)) {
      failure("final_thread_not_settled");
    }
    console.log("smoke_complete=true");
  } finally {
    await client.close().catch(() => undefined);
  }
}

main().catch((error) => {
  if (error instanceof SmokeFailure) {
    console.error(`smoke_stopped reason=${error.message}`);
  } else {
    console.error("smoke_stopped reason=unexpected_failure");
  }
  process.exitCode = 1;
});
