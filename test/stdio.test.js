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

async function startEnvironment({ id, label, grants, redirectTo } = {}) {
  const requests = [];
  const tokens = new Map();
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
      if (!token) {
        return jsonResponse(response, 401, {
          code: "auth_invalid",
          reason: "invalid_credential",
          subject_token: grant,
          access_token: "secret-error-token",
        });
      }
      tokens.set(token, true);
      return jsonResponse(response, 200, {
        access_token: token,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "orchestration:read orchestration:operate",
      });
    }

    if (request.method === "GET" && request.url === "/api/auth/session") {
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      if (!token || !tokens.has(token)) {
        return jsonResponse(response, 401, { code: "auth_invalid", token: "secret-session-token" });
      }
      return jsonResponse(response, 200, {
        authenticated: true,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["bearer-access-token"],
          sessionCookieName: "t3_session",
        },
        scopes: ["orchestration:read", "orchestration:operate"],
        sessionMethod: "bearer-access-token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }

    response.writeHead(404);
    response.end();
  });
  return { ...server, requests, tokens };
}

async function connectClient(stateDirectory) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [connectorPath],
    cwd: process.cwd(),
    env: { ...process.env, T3_MCP_STATE_DIR: stateDirectory, NODE_NO_WARNINGS: "1" },
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
      ["add_environment", "list_environments"],
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
  let client;
  try {
    client = await connectClient(stateDirectory);
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
    await sink.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
