import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const connectorPath = path.join(process.cwd(), "dist", "index.js");

function jsonResponse(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function startHttpServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function configuredResponse(value, url) {
  return typeof value === "function" ? value(url) : value;
}

async function writeConfiguredResponse(response, value, url, fallbackStatus = 200) {
  const resolved = await configuredResponse(value, url);
  if (
    resolved &&
    typeof resolved === "object" &&
    "status" in resolved &&
    "body" in resolved
  ) {
    return jsonResponse(response, resolved.status, resolved.body);
  }
  return jsonResponse(response, fallbackStatus, resolved);
}

async function startEnvironment({
  id,
  label,
  grants,
  redirectTo,
  projects = [],
  orchestration = {},
  dispatch,
  dpopGrants = new Map(),
} = {}) {
  const requests = [];
  const tokens = new Map();
  const tokenFromRequest = (request) => {
    const match = request.headers.authorization?.match(/^(Bearer|DPoP) (.+)$/);
    if (!match || tokens.get(match[2]) !== match[1]) return undefined;
    if (match[1] === "DPoP" && !request.headers.dpop) return undefined;
    return match[2];
  };
  const server = await startHttpServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ method: request.method, path: request.url, headers: request.headers, body });

    if (request.method === "GET" && request.url === "/.well-known/t3/environment") {
      return jsonResponse(response, 200, {
        environmentId: id,
        label,
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.42",
        orchestrationProtocolVersion: 1,
        capabilities: { connectionProbe: true },
      });
    }

    if (request.method === "POST" && request.url === "/oauth/token") {
      if (redirectTo) {
        response.writeHead(302, { location: `${redirectTo}/oauth/token` });
        return response.end();
      }
      const form = new URLSearchParams(body);
      const grant = form.get("subject_token");
      const token = grants?.get(grant);
      const dpopToken = dpopGrants.get(grant);
      const accessToken = dpopToken ?? token;
      if (!accessToken || (dpopToken && !request.headers.dpop)) {
        return jsonResponse(response, 401, {
          code: "auth_invalid",
          reason: "invalid_credential",
          subject_token: grant,
          access_token: "secret-error-token",
        });
      }
      tokens.set(accessToken, dpopToken ? "DPoP" : "Bearer");
      return jsonResponse(response, 200, {
        access_token: accessToken,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: dpopToken ? "DPoP" : "Bearer",
        expires_in: 3600,
        scope: "orchestration:read orchestration:operate",
      });
    }

    if (request.method === "GET" && request.url === "/api/auth/session") {
      const token = tokenFromRequest(request);
      if (!token) {
        return jsonResponse(response, 401, { code: "auth_invalid", token: "secret-session-token" });
      }
      return jsonResponse(response, 200, {
        authenticated: true,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: [tokens.get(token) === "DPoP" ? "dpop-access-token" : "bearer-access-token"],
          sessionCookieName: "t3_session",
        },
        scopes: ["orchestration:read", "orchestration:operate"],
        sessionMethod: tokens.get(token) === "DPoP" ? "dpop-access-token" : "bearer-access-token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }

    if (request.method === "GET" && request.url?.startsWith("/api/orchestration/")) {
      if (!tokenFromRequest(request)) {
        return jsonResponse(response, 401, { code: "auth_invalid", token: "secret-session-token" });
      }
      if (orchestration.status) {
        return jsonResponse(response, orchestration.status, { code: "denied", detail: "private detail" });
      }

      const url = new URL(request.url, "http://environment.test");
      if (url.pathname === "/api/orchestration/snapshot") {
        const snapshot =
          orchestration.snapshot ?? {
            snapshotSequence: 1,
            projects,
            threads: [],
            updatedAt: new Date().toISOString(),
          };
        return writeConfiguredResponse(response, snapshot, url);
      }

      const threadPrefix = "/api/orchestration/threads/";
      if (url.pathname.startsWith(threadPrefix)) {
        const threadId = decodeURIComponent(url.pathname.slice(threadPrefix.length));
        const thread = await configuredResponse(orchestration.thread, url);
        const configuredThread =
          thread ?? (orchestration.threads instanceof Map ? orchestration.threads.get(threadId) : undefined);
        if (configuredThread === undefined) {
          return jsonResponse(response, 404, { code: "not_found", reason: "thread_not_found" });
        }
        return writeConfiguredResponse(response, configuredThread, url);
      }
    }

    if (request.method === "POST" && request.url === "/api/orchestration/dispatch") {
      if (!tokenFromRequest(request)) {
        return jsonResponse(response, 401, { code: "auth_invalid", token: "secret-session-token" });
      }
      if (orchestration.status) {
        return jsonResponse(response, orchestration.status, { code: "denied", detail: "private detail" });
      }
      const command = JSON.parse(body);
      const resolved = typeof dispatch === "function" ? await dispatch(command) : dispatch;
      if (resolved?.drop) {
        request.socket.destroy();
        return;
      }
      if (
        resolved &&
        typeof resolved === "object" &&
        "status" in resolved &&
        "body" in resolved
      ) {
        return jsonResponse(response, resolved.status, resolved.body);
      }
      return jsonResponse(response, 200, resolved ?? { sequence: 1 });
    }

    response.writeHead(404);
    response.end();
  });
  return { ...server, requests, tokens };
}

function fakeJwtSubject(subject) {
  const payload = Buffer.from(JSON.stringify({ sub: subject })).toString("base64url");
  return `header.${payload}.signature`;
}

async function startConnectControl(environments) {
  const clerkRequests = [];
  const clerk = await startHttpServer(async (request, response) => {
    const body = await readBody(request);
    clerkRequests.push({ method: request.method, path: request.url, body });
    if (request.method === "POST" && request.url === "/oauth/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code" && form.get("code") === "browser-code") {
        return jsonResponse(response, 200, {
          access_token: "clerk-access-token",
          refresh_token: "clerk-refresh-token",
          id_token: fakeJwtSubject("connect-account-a"),
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (form.get("grant_type") === "refresh_token") {
        return jsonResponse(response, 200, {
          access_token: "clerk-refreshed-token",
          refresh_token: "clerk-refresh-token",
          id_token: fakeJwtSubject("connect-account-a"),
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
    }
    return jsonResponse(response, 400, { error: "invalid_request" });
  });

  const relayRequests = [];
  const relay = await startHttpServer(async (request, response) => {
    const body = await readBody(request);
    relayRequests.push({ method: request.method, path: request.url, headers: request.headers, body });
    if (request.method === "GET" && request.url === "/v1/environments") {
      if (request.headers.authorization !== "Bearer clerk-access-token" && request.headers.authorization !== "Bearer clerk-refreshed-token") {
        return jsonResponse(response, 401, { code: "auth_invalid" });
      }
      return jsonResponse(response, 200, {
        environments: environments.map((environment) => ({
          environmentId: environment.id,
          label: environment.label,
          endpoint: {
            httpBaseUrl: environment.baseUrl,
            wsBaseUrl: environment.baseUrl.replace(/^http/, "ws"),
            providerKind: "manual",
          },
          linkedAt: "2026-09-20T00:00:00.000Z",
        })),
      });
    }
    if (request.method === "POST" && request.url === "/v1/client/dpop-token") {
      if (!request.headers.dpop) return jsonResponse(response, 401, { code: "auth_invalid" });
      return jsonResponse(response, 200, {
        access_token: "relay-dpop-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "DPoP",
        expires_in: 3600,
        scope: "environment:connect",
      });
    }
    const connectMatch = request.url?.match(/^\/v1\/environments\/([^/]+)\/connect$/);
    if (request.method === "POST" && connectMatch) {
      if (request.headers.authorization !== "DPoP relay-dpop-token" || !request.headers.dpop) {
        return jsonResponse(response, 401, { code: "auth_invalid" });
      }
      const environment = environments.find((entry) => entry.id === decodeURIComponent(connectMatch[1]));
      if (!environment) return jsonResponse(response, 404, { code: "not_found" });
      return jsonResponse(response, 200, {
        environmentId: environment.id,
        endpoint: {
          httpBaseUrl: environment.baseUrl,
          wsBaseUrl: environment.baseUrl.replace(/^http/, "ws"),
          providerKind: "manual",
        },
        credential: environment.connectGrant,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      });
    }
    return jsonResponse(response, 404, { code: "not_found" });
  });

  return {
    env: {
      T3_MCP_CONNECT_RELAY_URL: relay.baseUrl,
      T3_MCP_CONNECT_TOKEN_ENDPOINT: `${clerk.baseUrl}/oauth/token`,
      T3_MCP_CONNECT_CLIENT_ID: "connect-client",
      T3_MCP_CONNECT_HOSTED_APP_URL: "https://app.t3.codes",
    },
    clerkRequests,
    relayRequests,
    close: async () => {
      await clerk.close();
      await relay.close();
    },
  };
}

async function connectClient(stateDirectory, extraEnvironment = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [connectorPath],
    cwd: process.cwd(),
    env: {
      ...process.env,
      T3_MCP_STATE_DIR: stateDirectory,
      NODE_NO_WARNINGS: "1",
      ...extraEnvironment,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "stdio-test-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function closeClient(client) {
  if (!client) return;
  await client.close().catch(() => undefined);
}

function content(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

const NOW = "2026-09-20T00:00:00.000Z";

function message(id, role, text, turnId = "turn-1") {
  return {
    id,
    role,
    text,
    attachments: [],
    turnId,
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function activity(kind, payload = {}) {
  return {
    id: `${kind}-activity`,
    tone: kind === "approval.requested" ? "approval" : "info",
    kind,
    summary: kind,
    payload,
    turnId: "turn-1",
    createdAt: NOW,
  };
}

function threadSnapshot({
  id = "thread-1",
  projectId = "project-1",
  title = "Thread",
  latestState = "completed",
  sessionStatus = "ready",
  activities = [],
  messages = [message("message-1", "assistant", "result")],
  page,
} = {}) {
  return {
    snapshotSequence: 7,
    thread: {
      id,
      projectId,
      title,
      modelSelection: { instanceId: "default", model: "model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn:
        latestState === null
          ? null
          : {
              turnId: "turn-1",
              state: latestState,
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: latestState === "completed" ? NOW : null,
              assistantMessageId: "message-1",
            },
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages,
      proposedPlans: [],
      activities,
      checkpoints: [],
      session:
        sessionStatus === null
          ? null
          : {
              threadId: id,
              status: sessionStatus,
              providerName: "provider",
              runtimeMode: "full-access",
              activeTurnId: sessionStatus === "running" ? "turn-1" : null,
              lastError: null,
              updatedAt: NOW,
            },
    },
    ...(page === undefined ? {} : { page }),
  };
}

test("pairs, persists, re-pairs safely, and lists through the public MCP seam", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-state-"));
  const environmentA = await startEnvironment({
    id: "environment-a",
    label: "Alpha",
    grants: new Map([
      ["grant-a", "access-token-a"],
      ["grant-a-repair", "access-token-a-repair"],
    ]),
  });
  const environmentB = await startEnvironment({
    id: "environment-b",
    label: "Beta",
    grants: new Map([["grant-b", "access-token-b"]]),
  });
  let client;
  let restartedClient;
  try {
    client = await connectClient(stateDirectory);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "add_environment",
        "attach_connect_environment",
        "connect_authenticate",
        "continue_turn",
        "get_thread",
        "list_connect_environments",
        "list_environments",
        "list_projects",
        "register_connect_environment",
        "sign_out_connect",
        "start_turn",
        "unregister_environment",
      ],
    );
    assert.ok(tools.tools.find((tool) => tool.name === "add_environment").inputSchema.properties.pairingUrl);

    const pairedA = await client.callTool({
      name: "add_environment",
      arguments: { pairingUrl: `${environmentA.baseUrl}/pair#token=grant-a`, label: "Alpha saved" },
    });
    assert.equal(pairedA.isError, undefined);
    assert.equal(content(pairedA).environment.id, "environment-a");
    assert.equal(JSON.stringify(pairedA).includes("grant-a"), false);
    assert.equal(JSON.stringify(pairedA).includes("access-token-a"), false);

    const pairedB = await client.callTool({
      name: "add_environment",
      arguments: { endpoint: environmentB.baseUrl, grant: "grant-b" },
    });
    assert.equal(content(pairedB).environment.id, "environment-b");

    const duplicate = await client.callTool({
      name: "add_environment",
      arguments: { endpoint: environmentA.baseUrl, grant: "grant-a", label: "overwrite" },
    });
    assert.equal(duplicate.isError, true);
    assert.equal(content(duplicate).error.code, "environment_exists");

    const conflictingTarget = await client.callTool({
      name: "add_environment",
      arguments: { endpoint: environmentB.baseUrl, grant: "grant-b", environmentId: "environment-a" },
    });
    assert.equal(conflictingTarget.isError, true);
    assert.equal(content(conflictingTarget).error.code, "environment_conflict");

    const repaired = await client.callTool({
      name: "add_environment",
      arguments: {
        pairingUrl: `${environmentA.baseUrl}/pair#token=grant-a-repair`,
        environmentId: "environment-a",
        label: "Alpha repaired",
      },
    });
    assert.equal(content(repaired).environment.label, "Alpha repaired");

    const failedReplacement = await client.callTool({
      name: "add_environment",
      arguments: {
        pairingUrl: `${environmentA.baseUrl}/pair#token=expired-grant`,
        environmentId: "environment-a",
      },
    });
    assert.equal(failedReplacement.isError, true);
    assert.equal(content(failedReplacement).error.code, "pairing_rejected");
    assert.equal(JSON.stringify(failedReplacement).includes("expired-grant"), false);
    assert.equal(JSON.stringify(failedReplacement).includes("secret-error-token"), false);

    const listBeforeRestart = await client.callTool({ name: "list_environments", arguments: {} });
    const environmentsBeforeRestart = content(listBeforeRestart).environments;
    assert.deepEqual(
      environmentsBeforeRestart.map((environment) => environment.id),
      ["environment-a", "environment-b"],
    );
    assert.equal(environmentsBeforeRestart[0].label, "Alpha repaired");
    assert.equal(environmentsBeforeRestart[0].endpoint, `${environmentA.baseUrl}/`);
    assert.equal(JSON.stringify(listBeforeRestart).includes("access-token-a"), false);
    assert.equal(JSON.stringify(listBeforeRestart).includes("access-token-b"), false);

    await closeClient(client);
    restartedClient = await connectClient(stateDirectory);
    const listAfterRestart = await restartedClient.callTool({ name: "list_environments", arguments: {} });
    assert.deepEqual(content(listAfterRestart).environments, environmentsBeforeRestart);

    const storedPath = path.join(stateDirectory, "environments.json");
    const directoryMode = (await stat(stateDirectory)).mode & 0o777;
    const fileMode = (await stat(storedPath)).mode & 0o777;
    assert.equal(directoryMode, 0o700);
    assert.equal(fileMode, 0o600);
    const stored = await readFile(storedPath, "utf8");
    assert.equal(stored.includes("grant-a"), false);
    assert.equal(stored.includes("access-token-a-repair"), true);

    const descriptorRequest = environmentA.requests.find(
      (request) => request.path === "/.well-known/t3/environment",
    );
    assert.equal(descriptorRequest.headers.authorization, undefined);
    const tokenRequest = environmentA.requests.find((request) => request.path === "/oauth/token");
    assert.match(tokenRequest.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange/);
    assert.match(tokenRequest.body, /scope=orchestration%3Aread\+orchestration%3Aoperate/);
  } finally {
    await closeClient(client);
    await closeClient(restartedClient);
    await environmentA.close();
    await environmentB.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("authenticates with Connect, discovers without registering, attaches, registers, and unregisters safely", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-connect-"));
  const environmentA = await startEnvironment({
    id: "environment-a",
    label: "Alpha",
    grants: new Map([["direct-grant-a", "direct-token-a"]]),
    dpopGrants: new Map([["connect-grant-a", "connect-token-a"]]),
    projects: [{ id: "project-a", title: "Alpha project" }],
  });
  const environmentB = await startEnvironment({
    id: "environment-b",
    label: "Beta",
    dpopGrants: new Map([["connect-grant-b", "connect-token-b"]]),
    projects: [{ id: "project-b", title: "Beta project" }],
  });
  const connect = await startConnectControl([
    { id: "environment-a", label: "Alpha Connect", baseUrl: environmentA.baseUrl, connectGrant: "connect-grant-a" },
    { id: "environment-b", label: "Beta Connect", baseUrl: environmentB.baseUrl, connectGrant: "connect-grant-b" },
  ]);
  let client;
  let restartedClient;
  try {
    client = await connectClient(stateDirectory, connect.env);
    const direct = await client.callTool({
      name: "add_environment",
      arguments: { endpoint: environmentA.baseUrl, grant: "direct-grant-a", label: "Alpha direct" },
    });
    assert.equal(content(direct).environment.id, "environment-a");

    const started = await client.callTool({ name: "connect_authenticate", arguments: {} });
    const authorizationUrl = content(started).authentication.authorizationUrl;
    assert.equal(content(started).authentication.status, "pending");
    const authorization = new URL(authorizationUrl);
    const fragment = new URLSearchParams(authorization.hash.slice(1));
    const callback = await fetch(
      `http://127.0.0.1:${fragment.get("port")}/callback?state=${encodeURIComponent(fragment.get("state"))}&code=browser-code`,
    );
    assert.equal(callback.status, 200);
    assert.equal(content(await client.callTool({ name: "connect_authenticate", arguments: { action: "status" } })).authentication.status, "authenticated");
    assert.equal(connect.clerkRequests.length, 1);
    assert.match(connect.clerkRequests[0].body, /code_verifier=/);

    const discovered = await client.callTool({ name: "list_connect_environments", arguments: {} });
    assert.deepEqual(content(discovered).environments.map((environment) => environment.id), ["environment-a", "environment-b"]);
    assert.deepEqual(
      content(await client.callTool({ name: "list_environments", arguments: {} })).environments.map((environment) => environment.id),
      ["environment-a"],
    );

    const attached = await client.callTool({
      name: "attach_connect_environment",
      arguments: { environmentId: "environment-a", targetEnvironmentId: "environment-a", label: "connect-grant-a" },
    });
    assert.equal(content(attached).environment.id, "environment-a");
    assert.equal(content(attached).environment.source, "connect");
    assert.equal(content(attached).environment.connectAttached, true);
    assert.equal(JSON.stringify(attached).includes("connect-grant-a"), false);

    const registered = await client.callTool({
      name: "register_connect_environment",
      arguments: { environmentId: "environment-b", label: "Beta registered" },
    });
    assert.equal(content(registered).environment.id, "environment-b");
    assert.equal(content(registered).environment.source, "connect");
    assert.equal(JSON.stringify(registered).includes("connect-grant-b"), false);
    assert.equal(JSON.stringify(registered).includes("connect-token-b"), false);

    const duplicate = await client.callTool({
      name: "register_connect_environment",
      arguments: { environmentId: "environment-a" },
    });
    assert.equal(duplicate.isError, true);
    assert.equal(content(duplicate).error.code, "environment_exists");

    const projects = await client.callTool({ name: "list_projects", arguments: { environmentId: "environment-b" } });
    assert.deepEqual(content(projects).projects, [{ id: "project-b", name: "Beta project" }]);
    const dpopRequest = environmentB.requests.find((request) => request.path === "/api/auth/session");
    assert.match(dpopRequest.headers.authorization, /^DPoP /);
    assert.ok(dpopRequest.headers.dpop);

    const unregistered = await client.callTool({
      name: "unregister_environment",
      arguments: { environmentId: "environment-b" },
    });
    assert.deepEqual(content(unregistered), { environmentId: "environment-b", unregistered: true });
    assert.deepEqual(
      content(await client.callTool({ name: "list_environments", arguments: {} })).environments.map((environment) => environment.id),
      ["environment-a"],
    );
    assert.deepEqual(content(await client.callTool({ name: "list_connect_environments", arguments: {} })).environments.map((environment) => environment.id), ["environment-a", "environment-b"]);

    const signedOut = await client.callTool({ name: "sign_out_connect", arguments: {} });
    assert.deepEqual(content(signedOut), { signedOut: true });
    const connectAfterSignOut = await client.callTool({ name: "list_connect_environments", arguments: {} });
    assert.equal(connectAfterSignOut.isError, true);
    assert.equal(content(connectAfterSignOut).error.code, "connect_auth_expired");
    assert.deepEqual(
      content(await client.callTool({ name: "list_projects", arguments: { environmentId: "environment-a" } })).projects,
      [{ id: "project-a", name: "Alpha project" }],
    );

    await closeClient(client);
    restartedClient = await connectClient(stateDirectory, connect.env);
    assert.deepEqual(
      content(await restartedClient.callTool({ name: "list_environments", arguments: {} })).environments.map((environment) => environment.id),
      ["environment-a"],
    );
    const missing = await restartedClient.callTool({ name: "list_projects", arguments: { environmentId: "environment-b" } });
    assert.equal(missing.isError, true);
    assert.equal(content(missing).error.code, "environment_not_found");
  } finally {
    await closeClient(client);
    await closeClient(restartedClient);
    await connect.close();
    await environmentA.close();
    await environmentB.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("rejects insecure input and redirects without forwarding the grant", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-security-"));
  const sinkHits = [];
  const sink = await startHttpServer(async (request, response) => {
    sinkHits.push({ method: request.method, path: request.url, headers: request.headers });
    response.writeHead(200);
    response.end();
  });
  const redirecting = await startEnvironment({
    id: "environment-redirect",
    label: "Redirect",
    redirectTo: sink.baseUrl,
  });
  const queryEnvironment = await startEnvironment({
    id: "environment-query",
    label: "Query",
    grants: new Map([["query-grant", "query-access-token"]]),
  });
  let client;
  try {
    client = await connectClient(stateDirectory);
    const queryPair = await client.callTool({
      name: "add_environment",
      arguments: { pairingUrl: `${queryEnvironment.baseUrl}/pair?token=query-grant` },
    });
    assert.equal(queryPair.isError, undefined);
    assert.equal(JSON.stringify(queryPair).includes("query-grant"), false);
    assert.equal(JSON.stringify(queryPair).includes("query-access-token"), false);
    assert.deepEqual(
      queryEnvironment.requests.map((request) => request.path),
      ["/.well-known/t3/environment", "/oauth/token", "/api/auth/session"],
    );

    const arbitraryQuery = await client.callTool({
      name: "add_environment",
      arguments: { pairingUrl: `${queryEnvironment.baseUrl}/pair?token=query-grant&extra=value` },
    });
    assert.equal(arbitraryQuery.isError, true);
    assert.equal(content(arbitraryQuery).error.code, "insecure_endpoint");

    const endpointQuery = await client.callTool({
      name: "add_environment",
      arguments: {
        endpoint: `${queryEnvironment.baseUrl}/pair?token=query-grant`,
        grant: "query-grant",
      },
    });
    assert.equal(endpointQuery.isError, true);
    assert.equal(content(endpointQuery).error.code, "insecure_endpoint");

    const insecure = await client.callTool({
      name: "add_environment",
      arguments: { endpoint: "http://example.com", grant: "never-send" },
    });
    assert.equal(insecure.isError, true);
    assert.equal(content(insecure).error.code, "insecure_endpoint");
    assert.equal(redirecting.requests.length, 0);

    const query = await client.callTool({
      name: "add_environment",
      arguments: { endpoint: `${redirecting.baseUrl}?token=query-secret`, grant: "never-send" },
    });
    assert.equal(query.isError, true);
    assert.equal(content(query).error.code, "insecure_endpoint");
    assert.equal(redirecting.requests.length, 0);

    const redirected = await client.callTool({
      name: "add_environment",
      arguments: {
        pairingUrl: `${redirecting.baseUrl}/pair#token=fragment-secret`,
      },
    });
    assert.equal(redirected.isError, true);
    assert.equal(content(redirected).error.code, "transport_error");
    assert.equal(sinkHits.length, 0);
    assert.equal(JSON.stringify(redirected).includes("fragment-secret"), false);
  } finally {
    await closeClient(client);
    await redirecting.close();
    await queryEnvironment.close();
    await sink.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("rejects repository-local credential storage with a sanitized error", async () => {
  let client;
  try {
    client = await connectClient(process.cwd());
    const result = await client.callTool({ name: "list_environments", arguments: {} });
    assert.equal(result.isError, true);
    assert.deepEqual(content(result).error, {
      code: "storage_error",
      message: "Environment registrations are unavailable.",
    });
    assert.equal(JSON.stringify(result).includes(process.cwd()), false);
  } finally {
    await closeClient(client);
  }
});

test("discovers projects and retrieves environment-scoped thread states", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-reads-"));
  const empty = await startEnvironment({
    id: "environment-empty",
    label: "Empty",
    grants: new Map([["grant-empty", "token-empty"]]),
  });
  const environmentA = await startEnvironment({
    id: "environment-a",
    label: "Alpha",
    grants: new Map([["grant-a", "token-a"]]),
    projects: [{ id: "same-project", title: "Alpha project", deletedAt: null }],
    orchestration: {
      threads: new Map([
        [
          "same-thread",
          threadSnapshot({ id: "same-thread", projectId: "same-project", title: "Alpha thread", latestState: "running", sessionStatus: "running" }),
        ],
        [
          "approval-thread",
          threadSnapshot({
            id: "approval-thread",
            projectId: "same-project",
            title: "Approval thread",
            latestState: "running",
            sessionStatus: "running",
            activities: [activity("approval.requested", { requestId: "request-1" })],
          }),
        ],
        [
          "unknown-thread",
          threadSnapshot({
            id: "unknown-thread",
            projectId: "same-project",
            latestState: "future-state",
            sessionStatus: "ready",
          }),
        ],
      ]),
    },
  });
  const environmentB = await startEnvironment({
    id: "environment-b",
    label: "Beta",
    grants: new Map([["grant-b", "token-b"]]),
    projects: [{ id: "same-project", title: "Beta project", deletedAt: null }],
    orchestration: {
      threads: new Map([
        [
          "same-thread",
          threadSnapshot({ id: "same-thread", projectId: "same-project", title: "Beta thread" }),
        ],
      ]),
    },
  });
  let client;
  try {
    client = await connectClient(stateDirectory);
    for (const [environment, grant] of [
      [empty, "grant-empty"],
      [environmentA, "grant-a"],
      [environmentB, "grant-b"],
    ]) {
      const paired = await client.callTool({
        name: "add_environment",
        arguments: { endpoint: environment.baseUrl, grant },
      });
      assert.equal(paired.isError, undefined);
    }

    const emptyProjects = await client.callTool({
      name: "list_projects",
      arguments: { environmentId: "environment-empty" },
    });
    assert.deepEqual(content(emptyProjects), {
      environmentId: "environment-empty",
      projects: [],
    });

    const projectsA = await client.callTool({
      name: "list_projects",
      arguments: { environmentId: "environment-a" },
    });
    assert.deepEqual(content(projectsA).projects, [{ id: "same-project", name: "Alpha project" }]);

    const projectsB = await client.callTool({
      name: "list_projects",
      arguments: { environmentId: "environment-b" },
    });
    assert.deepEqual(content(projectsB).projects, [{ id: "same-project", name: "Beta project" }]);

    const running = await client.callTool({
      name: "get_thread",
      arguments: { environmentId: "environment-a", threadId: "same-thread" },
    });
    assert.equal(content(running).thread.environmentId, "environment-a");
    assert.equal(content(running).thread.title, "Alpha thread");
    assert.equal(content(running).thread.status, "running");
    assert.equal(content(running).thread.messages[0].text, "result");

    const completed = await client.callTool({
      name: "get_thread",
      arguments: { environmentId: "environment-b", threadId: "same-thread" },
    });
    assert.equal(content(completed).thread.environmentId, "environment-b");
    assert.equal(content(completed).thread.title, "Beta thread");
    assert.equal(content(completed).thread.status, "completed");

    const approval = await client.callTool({
      name: "get_thread",
      arguments: { environmentId: "environment-a", threadId: "approval-thread" },
    });
    assert.equal(content(approval).thread.status, "approval_required");
    assert.equal(content(approval).thread.activities[0].kind, "approval.requested");

    const unknown = await client.callTool({
      name: "get_thread",
      arguments: { environmentId: "environment-a", threadId: "unknown-thread" },
    });
    assert.equal(content(unknown).thread.status, "unknown");
    assert.equal(content(unknown).thread.upstreamState, "future-state");

    const routedA = environmentA.requests.filter((request) => request.path.startsWith("/api/orchestration/"));
    const routedB = environmentB.requests.filter((request) => request.path.startsWith("/api/orchestration/"));
    assert.ok(routedA.every((request) => request.headers.authorization === "Bearer token-a"));
    assert.ok(routedB.every((request) => request.headers.authorization === "Bearer token-b"));
    assert.equal(routedA.some((request) => request.path.includes("same-thread")), true);
    assert.equal(routedB.some((request) => request.path.includes("same-thread")), true);
  } finally {
    await closeClient(client);
    await empty.close();
    await environmentA.close();
    await environmentB.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("starts a turn through acknowledged dispatch and observes running and completed results", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-start-"));
  let startedThreadId;
  let completed = false;
  let continuationStarted = false;
  let continuationCompleted = false;
  const dispatched = [];
  const environment = await startEnvironment({
    id: "environment-start",
    label: "Start",
    grants: new Map([["grant-start", "token-start"]]),
    projects: [
      {
        id: "project-start",
        title: "Start project",
        deletedAt: null,
        defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
      },
    ],
    orchestration: {
      thread: () => {
        const running = continuationStarted ? !continuationCompleted : !completed;
        return threadSnapshot({
          id: startedThreadId,
          projectId: "project-start",
          latestState: running ? "running" : "completed",
          sessionStatus: running ? "running" : "ready",
          messages: continuationStarted
            ? [
                message("user-1", "user", "Inspect the project and report the result.", "turn-1"),
                message("assistant-1", "assistant", "initial result", "turn-1"),
                message("user-2", "user", "Check the same thread.", "turn-2"),
                message(
                  "assistant-2",
                  "assistant",
                  continuationCompleted ? "continued result" : "continued work",
                  "turn-2",
                ),
              ]
            : undefined,
        });
      },
    },
    dispatch: (command) => {
      dispatched.push(command);
      if (command.type === "thread.create") startedThreadId = command.threadId;
      if (
        command.type === "thread.turn.start" &&
        dispatched.filter((entry) => entry.type === "thread.turn.start").length === 2
      ) {
        continuationStarted = true;
      }
      return { sequence: dispatched.length };
    },
  });
  let client;
  try {
    client = await connectClient(stateDirectory);
    const paired = await client.callTool({
      name: "add_environment",
      arguments: { endpoint: environment.baseUrl, grant: "grant-start" },
    });
    assert.equal(paired.isError, undefined);

    const started = await client.callTool({
      name: "start_turn",
      arguments: {
        environmentId: "environment-start",
        projectId: "project-start",
        prompt: "Inspect the project and report the result.",
      },
    });
    const start = content(started).start;
    assert.equal(start.outcome, "acknowledged");
    assert.equal(start.environmentId, "environment-start");
    assert.equal(start.projectId, "project-start");
    assert.equal(start.threadId, startedThreadId);
    assert.equal(start.createSequence, 1);
    assert.equal(start.turnSequence, 2);
    assert.equal("turnId" in start, false);
    assert.deepEqual(dispatched.map((command) => command.type), ["thread.create", "thread.turn.start"]);
    assert.equal(dispatched[0].modelSelection.instanceId, "codex");
    assert.equal(dispatched[1].message.text, "Inspect the project and report the result.");

    const running = await client.callTool({
      name: "get_thread",
      arguments: { environmentId: "environment-start", threadId: startedThreadId },
    });
    assert.equal(content(running).thread.status, "running");

    completed = true;
    const finished = await client.callTool({
      name: "get_thread",
      arguments: { environmentId: "environment-start", threadId: startedThreadId },
    });
    assert.equal(content(finished).thread.status, "completed");

    const continued = await client.callTool({
      name: "continue_turn",
      arguments: {
        environmentId: "environment-start",
        threadId: startedThreadId,
        prompt: "Check the same thread.",
      },
    });
    const continuation = content(continued).continuation;
    assert.equal(continuation.outcome, "acknowledged");
    assert.equal(continuation.environmentId, "environment-start");
    assert.equal(continuation.threadId, startedThreadId);
    assert.ok(continuation.turnCommandId);
    assert.ok(continuation.messageId);
    assert.equal(continuation.turnSequence, 3);
    assert.deepEqual(
      dispatched.map((command) => command.type),
      ["thread.create", "thread.turn.start", "thread.turn.start"],
    );
    assert.equal(dispatched[2].threadId, startedThreadId);
    assert.equal(dispatched[2].message.text, "Check the same thread.");
    assert.equal(dispatched[2].message.role, "user");
    assert.deepEqual(dispatched[2].message.attachments, []);

    const continuedRunning = await client.callTool({
      name: "get_thread",
      arguments: { environmentId: "environment-start", threadId: startedThreadId },
    });
    assert.equal(content(continuedRunning).thread.status, "running");

    continuationCompleted = true;
    const continuedFinished = await client.callTool({
      name: "get_thread",
      arguments: { environmentId: "environment-start", threadId: startedThreadId },
    });
    const continuedThread = content(continuedFinished).thread;
    assert.equal(continuedThread.status, "completed");
    assert.deepEqual(
      continuedThread.messages.map((entry) => [entry.role, entry.text, entry.turnId]),
      [
        ["user", "Inspect the project and report the result.", "turn-1"],
        ["assistant", "initial result", "turn-1"],
        ["user", "Check the same thread.", "turn-2"],
        ["assistant", "continued result", "turn-2"],
      ],
    );
  } finally {
    await closeClient(client);
    await environment.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("reports active and approval-blocked continuation threads without dispatching", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-continue-conflicts-"));
  let dispatchCount = 0;
  const environment = await startEnvironment({
    id: "environment-continue-conflicts",
    label: "Continue conflicts",
    grants: new Map([["grant-continue-conflicts", "token-continue-conflicts"]]),
    orchestration: {
      threads: new Map([
        [
          "active-thread",
          threadSnapshot({ id: "active-thread", latestState: "running", sessionStatus: "running" }),
        ],
        [
          "approval-thread",
          threadSnapshot({
            id: "approval-thread",
            latestState: "running",
            sessionStatus: "running",
            activities: [activity("approval.requested", { requestId: "approval-1" })],
          }),
        ],
      ]),
    },
    dispatch: () => {
      dispatchCount += 1;
      return { sequence: dispatchCount };
    },
  });
  let client;
  try {
    client = await connectClient(stateDirectory);
    const paired = await client.callTool({
      name: "add_environment",
      arguments: { endpoint: environment.baseUrl, grant: "grant-continue-conflicts" },
    });
    assert.equal(paired.isError, undefined);

    for (const arguments_ of [
      { environmentId: "", threadId: "active-thread", prompt: "do work" },
      { environmentId: "environment-continue-conflicts", threadId: "", prompt: "do work" },
      { environmentId: "environment-continue-conflicts", threadId: "active-thread", prompt: " " },
    ]) {
      const invalid = await client.callTool({ name: "continue_turn", arguments: arguments_ });
      assert.equal(invalid.isError, true);
    }

    const active = await client.callTool({
      name: "continue_turn",
      arguments: {
        environmentId: "environment-continue-conflicts",
        threadId: "active-thread",
        prompt: "do not queue this",
      },
    });
    assert.equal(content(active).error.code, "thread_busy");

    const approval = await client.callTool({
      name: "continue_turn",
      arguments: {
        environmentId: "environment-continue-conflicts",
        threadId: "approval-thread",
        prompt: "do not bypass approval",
      },
    });
    assert.equal(content(approval).error.code, "approval_required");
    assert.equal(dispatchCount, 0);
  } finally {
    await closeClient(client);
    await environment.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("uses the upstream dispatch result when a thread changes after observation", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-continue-race-"));
  let observed = false;
  let dispatchCount = 0;
  const environment = await startEnvironment({
    id: "environment-continue-race",
    label: "Continue race",
    grants: new Map([["grant-continue-race", "token-continue-race"]]),
    orchestration: {
      thread: () =>
        threadSnapshot({
          id: "race-thread",
          latestState: observed ? "running" : "completed",
          sessionStatus: observed ? "running" : "ready",
        }),
    },
    dispatch: () => {
      dispatchCount += 1;
      observed = true;
      return { status: 409, body: { code: "conflict", detail: "private conflict detail" } };
    },
  });
  let client;
  try {
    client = await connectClient(stateDirectory);
    const paired = await client.callTool({
      name: "add_environment",
      arguments: { endpoint: environment.baseUrl, grant: "grant-continue-race" },
    });
    assert.equal(paired.isError, undefined);

    const result = await client.callTool({
      name: "continue_turn",
      arguments: {
        environmentId: "environment-continue-race",
        threadId: "race-thread",
        prompt: "dispatch must recheck the state",
      },
    });
    assert.equal(result.isError, true);
    assert.equal(content(result).error.code, "dispatch_conflict");
    assert.equal(JSON.stringify(result).includes("private conflict detail"), false);
    assert.equal(dispatchCount, 1);
  } finally {
    await closeClient(client);
    await environment.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("reports revoked authorization and missing continuation threads safely", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-continue-errors-"));
  let revokedDispatchCount = 0;
  let missingDispatchCount = 0;
  const revoked = await startEnvironment({
    id: "environment-revoked-continue",
    label: "Revoked continuation",
    grants: new Map([["grant-revoked-continue", "token-revoked-continue"]]),
    orchestration: {
      threads: new Map([["existing-thread", threadSnapshot({ id: "existing-thread" })]]),
    },
    dispatch: () => {
      revokedDispatchCount += 1;
      return { sequence: revokedDispatchCount };
    },
  });
  const missing = await startEnvironment({
    id: "environment-missing-continue",
    label: "Missing continuation",
    grants: new Map([["grant-missing-continue", "token-missing-continue"]]),
    dispatch: () => {
      missingDispatchCount += 1;
      return { sequence: missingDispatchCount };
    },
  });
  let client;
  try {
    client = await connectClient(stateDirectory);
    for (const [server, grant] of [
      [revoked, "grant-revoked-continue"],
      [missing, "grant-missing-continue"],
    ]) {
      const paired = await client.callTool({
        name: "add_environment",
        arguments: { endpoint: server.baseUrl, grant },
      });
      assert.equal(paired.isError, undefined);
    }

    revoked.tokens.clear();
    const unauthorized = await client.callTool({
      name: "continue_turn",
      arguments: {
        environmentId: "environment-revoked-continue",
        threadId: "existing-thread",
        prompt: "the session is revoked",
      },
    });
    assert.equal(content(unauthorized).error.code, "session_expired");
    assert.equal(JSON.stringify(unauthorized).includes("secret-session-token"), false);

    const notFound = await client.callTool({
      name: "continue_turn",
      arguments: {
        environmentId: "environment-missing-continue",
        threadId: "missing-thread",
        prompt: "there is no such thread",
      },
    });
    assert.equal(content(notFound).error.code, "thread_not_found");
    assert.equal(missingDispatchCount, 0);
    assert.equal(revokedDispatchCount, 0);
  } finally {
    await closeClient(client);
    await revoked.close();
    await missing.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("reports a dropped continuation acknowledgement as unknown without replaying it", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-continue-unknown-"));
  let dispatchCount = 0;
  const environment = await startEnvironment({
    id: "environment-continue-unknown",
    label: "Unknown continuation",
    grants: new Map([["grant-continue-unknown", "token-continue-unknown"]]),
    orchestration: {
      threads: new Map([["known-thread", threadSnapshot({ id: "known-thread" })]]),
    },
    dispatch: () => {
      dispatchCount += 1;
      return { drop: true };
    },
  });
  let client;
  try {
    client = await connectClient(stateDirectory);
    const paired = await client.callTool({
      name: "add_environment",
      arguments: { endpoint: environment.baseUrl, grant: "grant-continue-unknown" },
    });
    assert.equal(paired.isError, undefined);

    const result = await client.callTool({
      name: "continue_turn",
      arguments: {
        environmentId: "environment-continue-unknown",
        threadId: "known-thread",
        prompt: "the acknowledgement may be lost",
      },
    });
    const continuation = content(result).continuation;
    assert.equal(continuation.outcome, "unknown");
    assert.equal(continuation.error.code, "unknown_outcome");
    assert.equal(continuation.threadId, "known-thread");
    assert.ok(continuation.turnCommandId);
    assert.ok(continuation.messageId);
    assert.equal(dispatchCount, 1);
  } finally {
    await closeClient(client);
    await environment.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("validates start inputs and project access before dispatching", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-start-validation-"));
  const environment = await startEnvironment({
    id: "environment-validation",
    label: "Validation",
    grants: new Map([["grant-validation", "token-validation"]]),
    projects: [
      {
        id: "project-present",
        title: "Present project",
        deletedAt: null,
        defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
      },
    ],
  });
  const denied = await startEnvironment({
    id: "environment-denied-start",
    label: "Denied start",
    grants: new Map([["grant-denied-start", "token-denied-start"]]),
    orchestration: { status: 403 },
  });
  let client;
  try {
    client = await connectClient(stateDirectory);
    for (const [server, grant] of [
      [environment, "grant-validation"],
      [denied, "grant-denied-start"],
    ]) {
      const paired = await client.callTool({
        name: "add_environment",
        arguments: { endpoint: server.baseUrl, grant },
      });
      assert.equal(paired.isError, undefined);
    }

    for (const arguments_ of [
      { environmentId: "environment-validation", projectId: "project-present", prompt: " " },
      { environmentId: "environment-validation", projectId: "", prompt: "do work" },
      { environmentId: "", projectId: "project-present", prompt: "do work" },
    ]) {
      const invalid = await client.callTool({ name: "start_turn", arguments: arguments_ });
      assert.equal(invalid.isError, true);
    }

    const missing = await client.callTool({
      name: "start_turn",
      arguments: {
        environmentId: "environment-validation",
        projectId: "project-missing",
        prompt: "do work",
      },
    });
    assert.equal(content(missing).error.code, "project_not_found");

    const deniedResult = await client.callTool({
      name: "start_turn",
      arguments: {
        environmentId: "environment-denied-start",
        projectId: "project-present",
        prompt: "do work",
      },
    });
    assert.equal(content(deniedResult).error.code, "permission_denied");
    assert.equal(
      environment.requests.some((request) => request.path === "/api/orchestration/dispatch"),
      false,
    );
    assert.equal(
      denied.requests.some((request) => request.path === "/api/orchestration/dispatch"),
      false,
    );
  } finally {
    await closeClient(client);
    await environment.close();
    await denied.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("returns the created thread when first-turn dispatch fails", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-start-partial-"));
  const dispatched = [];
  const environment = await startEnvironment({
    id: "environment-partial",
    label: "Partial",
    grants: new Map([["grant-partial", "token-partial"]]),
    projects: [
      {
        id: "project-partial",
        title: "Partial project",
        deletedAt: null,
        defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
      },
    ],
    dispatch: (command) => {
      dispatched.push(command);
      return command.type === "thread.create"
        ? { sequence: 10 }
        : { status: 500, body: { code: "private", detail: "do not expose" } };
    },
  });
  let client;
  try {
    client = await connectClient(stateDirectory);
    const paired = await client.callTool({
      name: "add_environment",
      arguments: { endpoint: environment.baseUrl, grant: "grant-partial" },
    });
    assert.equal(paired.isError, undefined);

    const result = await client.callTool({
      name: "start_turn",
      arguments: {
        environmentId: "environment-partial",
        projectId: "project-partial",
        prompt: "fail the first turn",
      },
    });
    const start = content(result).start;
    assert.equal(start.outcome, "partial");
    assert.equal(start.threadId, dispatched[0].threadId);
    assert.equal(start.createSequence, 10);
    assert.ok(start.createCommandId);
    assert.ok(start.turnCommandId);
    assert.equal(start.error.code, "dispatch_failed");
    assert.equal(JSON.stringify(result).includes("do not expose"), false);
    assert.deepEqual(dispatched.map((command) => command.type), ["thread.create", "thread.turn.start"]);
  } finally {
    await closeClient(client);
    await environment.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("reports a dropped create acknowledgement as unknown without replaying it", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-start-unknown-"));
  let dispatchCount = 0;
  const environment = await startEnvironment({
    id: "environment-unknown",
    label: "Unknown",
    grants: new Map([["grant-unknown", "token-unknown"]]),
    projects: [
      {
        id: "project-unknown",
        title: "Unknown project",
        deletedAt: null,
        defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
      },
    ],
    dispatch: () => {
      dispatchCount += 1;
      return { drop: true };
    },
  });
  let client;
  try {
    client = await connectClient(stateDirectory);
    const paired = await client.callTool({
      name: "add_environment",
      arguments: { endpoint: environment.baseUrl, grant: "grant-unknown" },
    });
    assert.equal(paired.isError, undefined);

    const result = await client.callTool({
      name: "start_turn",
      arguments: {
        environmentId: "environment-unknown",
        projectId: "project-unknown",
        prompt: "the acknowledgement may be lost",
      },
    });
    const start = content(result).start;
    assert.equal(start.outcome, "unknown");
    assert.equal(start.error.code, "unknown_outcome");
    assert.ok(start.threadId);
    assert.equal(start.turnCommandId, undefined);
    assert.equal(dispatchCount, 1);
  } finally {
    await closeClient(client);
    await environment.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("uses upstream thread pagination and reports explicit truncation", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-pagination-"));
  const environment = await startEnvironment({
    id: "environment-pagination",
    label: "Pagination",
    grants: new Map([["grant-pagination", "token-pagination"]]),
    orchestration: {
      thread: (url) =>
        url.searchParams.get("beforeCursor") === "older-cursor"
          ? threadSnapshot({
              id: "paged-thread",
              messages: [message("older-message", "assistant", "older")],
              page: {
                beforeCursor: null,
                hasMore: false,
                snapshotSequence: 9,
                threadSequence: 8,
              },
            })
          : threadSnapshot({
              id: "paged-thread",
              messages: [message("newer-message", "assistant", "newer")],
              page: {
                beforeCursor: "older-cursor",
                hasMore: true,
                snapshotSequence: 8,
                threadSequence: 7,
              },
            }),
    },
  });
  let client;
  try {
    client = await connectClient(stateDirectory);
    const paired = await client.callTool({
      name: "add_environment",
      arguments: { endpoint: environment.baseUrl, grant: "grant-pagination" },
    });
    assert.equal(paired.isError, undefined);

    const first = await client.callTool({
      name: "get_thread",
      arguments: { environmentId: "environment-pagination", threadId: "paged-thread", turnLimit: 2 },
    });
    assert.deepEqual(content(first).thread.history, {
      turnLimit: 2,
      hasMore: true,
      nextCursor: "older-cursor",
      truncated: true,
      snapshotSequence: 8,
      threadSequence: 7,
    });

    const second = await client.callTool({
      name: "get_thread",
      arguments: {
        environmentId: "environment-pagination",
        threadId: "paged-thread",
        turnLimit: 2,
        beforeCursor: "older-cursor",
      },
    });
    assert.deepEqual(content(second).thread.history, {
      turnLimit: 2,
      hasMore: false,
      nextCursor: null,
      truncated: false,
      snapshotSequence: 9,
      threadSequence: 8,
    });

    const threadRequests = environment.requests.filter((request) => request.path.startsWith("/api/orchestration/threads/"));
    assert.equal(new URL(`http://environment.test${threadRequests[0].path}`).searchParams.get("turnLimit"), "2");
    assert.equal(new URL(`http://environment.test${threadRequests[1].path}`).searchParams.get("beforeCursor"), "older-cursor");
  } finally {
    await closeClient(client);
    await environment.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("returns sanitized errors for missing, denied, expired, and malformed reads", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-read-errors-"));
  const denied = await startEnvironment({
    id: "environment-denied",
    label: "Denied",
    grants: new Map([["grant-denied", "token-denied"]]),
    orchestration: { status: 403 },
  });
  const malformed = await startEnvironment({
    id: "environment-malformed",
    label: "Malformed",
    grants: new Map([["grant-malformed", "token-malformed"]]),
    orchestration: { snapshot: { snapshotSequence: 1, projects: "not-an-array" } },
  });
  const malformedThread = await startEnvironment({
    id: "environment-malformed-thread",
    label: "Malformed thread",
    grants: new Map([["grant-malformed-thread", "token-malformed-thread"]]),
    orchestration: {
      thread: {
        snapshotSequence: 1,
        thread: { id: "thread-1" },
      },
    },
  });
  let client;
  try {
    client = await connectClient(stateDirectory);
    for (const [environment, grant] of [
      [denied, "grant-denied"],
      [malformed, "grant-malformed"],
      [malformedThread, "grant-malformed-thread"],
    ]) {
      const paired = await client.callTool({
        name: "add_environment",
        arguments: { endpoint: environment.baseUrl, grant },
      });
      assert.equal(paired.isError, undefined);
    }

    const missingEnvironment = await client.callTool({
      name: "list_projects",
      arguments: { environmentId: "not-saved" },
    });
    assert.equal(content(missingEnvironment).error.code, "environment_not_found");

    const missingThread = await client.callTool({
      name: "get_thread",
      arguments: { environmentId: "environment-malformed", threadId: "missing" },
    });
    assert.equal(content(missingThread).error.code, "thread_not_found");

    const deniedProjects = await client.callTool({
      name: "list_projects",
      arguments: { environmentId: "environment-denied" },
    });
    assert.equal(content(deniedProjects).error.code, "permission_denied");
    assert.equal(JSON.stringify(deniedProjects).includes("private detail"), false);

    const malformedProjects = await client.callTool({
      name: "list_projects",
      arguments: { environmentId: "environment-malformed" },
    });
    assert.equal(content(malformedProjects).error.code, "upstream_incompatible");

    const malformedThreadResult = await client.callTool({
      name: "get_thread",
      arguments: { environmentId: "environment-malformed-thread", threadId: "thread-1" },
    });
    assert.equal(content(malformedThreadResult).error.code, "upstream_incompatible");

    denied.tokens.clear();
    const expired = await client.callTool({
      name: "list_projects",
      arguments: { environmentId: "environment-denied" },
    });
    assert.equal(content(expired).error.code, "session_expired");
  } finally {
    await closeClient(client);
    await denied.close();
    await malformed.close();
    await malformedThread.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
