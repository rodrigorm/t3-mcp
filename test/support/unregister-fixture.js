import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export function gate() {
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await released; } };
}

export function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

export async function http(handler) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      await handler(request, response, Buffer.concat(chunks).toString("utf8"));
    } catch {
      json(response, { error: "fixture_failure" }, 500);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export async function environment(id) {
  const requests = [];
  const pauses = new Map();
  const tokens = new Map();
  const server = await http(async (request, response, body) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url === "/.well-known/t3/environment") {
      return json(response, {
        environmentId: id, label: id, platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.42", orchestrationProtocolVersion: 1,
        capabilities: { connectionProbe: true },
      });
    }
    if (request.url === "/oauth/token") {
      const grant = new URLSearchParams(body).get("subject_token");
      await pauses.get(grant)?.wait();
      const tokenType = grant.startsWith("connect-") ? "DPoP" : "Bearer";
      const token = `session-${id}-${grant}`;
      tokens.set(token, tokenType);
      return json(response, {
        access_token: token, token_type: tokenType,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        expires_in: 3600, scope: "orchestration:read orchestration:operate",
      });
    }
    const [type, token] = request.headers.authorization?.split(" ") ?? [];
    if (!tokens.has(token) || tokens.get(token) !== type || (type === "DPoP" && !request.headers.dpop)) {
      return json(response, { error: "unauthorized" }, 401);
    }
    if (request.url === "/api/auth/session") {
      return json(response, {
        authenticated: true,
        auth: { policy: "loopback-browser", bootstrapMethods: ["one-time-token"],
          sessionMethods: [type === "DPoP" ? "dpop-access-token" : "bearer-access-token"], sessionCookieName: "t3_session" },
        scopes: ["orchestration:read", "orchestration:operate"],
        sessionMethod: type === "DPoP" ? "dpop-access-token" : "bearer-access-token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (request.url === "/api/orchestration/snapshot") {
      return json(response, { snapshotSequence: 1, projects: [{ id: `project-${id}`, title: id }],
        threads: [], updatedAt: new Date().toISOString() });
    }
    json(response, { error: "not_found" }, 404);
  });
  return { ...server, id, requests, pauses, tokens };
}

export async function fixture(t, ids = ["a", "b"], extraEnvironment = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-unregister-"));
  const environments = await Promise.all(ids.map(environment));
  const clients = [];
  const gates = [];
  async function client(env = extraEnvironment, connectorPath = path.join(process.cwd(), "dist/index.js")) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [connectorPath],
      cwd: process.cwd(), env: { ...process.env, T3_MCP_STATE_DIR: directory, ...env }, stderr: "pipe" });
    let stderr = "";
    transport.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const result = new Client({ name: "unregister-test", version: "1.0.0" });
    await result.connect(transport);
    clients.push(result);
    return { client: result, stderr: () => stderr };
  }
  t.after(async () => {
    for (const pause of gates) pause.release();
    await Promise.all(clients.map((entry) => entry.close().catch(() => undefined)));
    await Promise.all(environments.map((entry) => entry.close()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, environments, client, pause(environment, grant) {
    const pause = gate();
    gates.push(pause);
    environment.pauses.set(grant, pause);
    return pause;
  } };
}

export function content(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

export async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

export function success(result) {
  assert.equal(result.isError, undefined);
  return content(result);
}

export function failure(result, code) {
  assert.equal(result.isError, true);
  assert.equal(content(result).error.code, code);
}

export function add(client, environment, grant = "direct", extra = {}) {
  return call(client, "add_environment", { endpoint: environment.baseUrl, grant, ...extra });
}

export async function saved(client) {
  return success(await call(client, "list_environments")).environments;
}

export async function connectControl(t, environments) {
  const clerk = await http((request, response) => json(response, {
    access_token: "unregister-clerk-access", refresh_token: "unregister-clerk-refresh",
    id_token: `header.${Buffer.from(JSON.stringify({ sub: "unregister-account" })).toString("base64url")}.signature`,
    expires_in: 3600, token_type: "Bearer",
  }));
  const relay = await http((request, response) => {
    if (request.url === "/v1/environments") {
      return json(response, { environments: environments.map((environment) => ({
        environmentId: environment.id, label: environment.id,
        endpoint: { httpBaseUrl: environment.baseUrl, wsBaseUrl: environment.baseUrl.replace(/^http/, "ws"), providerKind: "manual" },
        linkedAt: "2026-09-20T00:00:00.000Z",
      })) });
    }
    if (request.url === "/v1/client/dpop-token") {
      return json(response, { access_token: "unregister-relay-session", token_type: "DPoP",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token", expires_in: 3600, scope: "environment:connect" });
    }
    const id = request.url?.match(/^\/v1\/environments\/([^/]+)\/connect$/)?.[1];
    const environment = environments.find((entry) => entry.id === id);
    if (environment) {
      return json(response, { environmentId: id,
        endpoint: { httpBaseUrl: environment.baseUrl, wsBaseUrl: environment.baseUrl.replace(/^http/, "ws"), providerKind: "manual" },
        credential: `connect-${id}`, expiresAt: new Date(Date.now() + 120_000).toISOString() });
    }
    json(response, { error: "not_found" }, 404);
  });
  t.after(async () => { await clerk.close(); await relay.close(); });
  return {
    T3_MCP_CONNECT_RELAY_URL: relay.baseUrl,
    T3_MCP_CONNECT_TOKEN_ENDPOINT: `${clerk.baseUrl}/oauth/token`,
    T3_MCP_CONNECT_CLIENT_ID: "unregister-client",
    T3_MCP_CONNECT_HOSTED_APP_URL: "https://app.t3.codes",
  };
}

export async function login(client) {
  const authentication = success(await call(client, "connect_authenticate")).authentication;
  assert.equal(authentication.status, "pending");
  const fragment = new URLSearchParams(new URL(authentication.authorizationUrl).hash.slice(1));
  const callback = await fetch(`http://127.0.0.1:${fragment.get("port")}/callback?state=${encodeURIComponent(fragment.get("state"))}&code=unregister-browser-code`);
  assert.equal(callback.status, 200);
  assert.equal(success(await call(client, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
}
