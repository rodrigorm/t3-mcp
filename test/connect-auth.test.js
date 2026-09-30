import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { watch } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const jwt = (sub) => `header.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.signature`;
const token = (overrides = {}) => ({
  access_token: jwt("account-a"), refresh_token: "fixture-refresh", id_token: jwt("account-a"),
  token_type: "Bearer", expires_in: 3600, ...overrides,
});
const record = (overrides = {}) => ({
  environmentId: "remote-a", label: "Remote", linkedAt: "2026-09-20T00:00:00.000Z",
  endpoint: { httpBaseUrl: "https://remote.example", wsBaseUrl: "wss://remote.example", providerKind: "manual" },
  ...overrides,
});
function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-connect-auth-"));
  const requests = [];
  const server = createServer(async (request, response) => {
    const form = new URLSearchParams(await body(request));
    requests.push({ method: request.method, path: request.url, form, headers: request.headers });
    if (request.url === "/oauth/token") {
      if (form.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange") {
        return json(response, { access_token: "direct-session", token_type: "Bearer", expires_in: 3600,
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          scope: "orchestration:read orchestration:operate" });
      }
      const handler = form.get("grant_type") === "refresh_token" ? options.refresh : options.exchange;
      return handler ? handler(response, form) : json(response, token());
    }
    if (request.url === "/v1/environments") {
      return options.discover ? options.discover(response, request) : json(response, { environments: [record()] });
    }
    if (request.url === "/.well-known/t3/environment") return json(response, {
      environmentId: "direct-a", label: "Direct", platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.42", orchestrationProtocolVersion: 1, capabilities: { connectionProbe: true },
    });
    if (request.url.startsWith("/api/") && request.headers.authorization !== "Bearer direct-session") {
      return json(response, { error: "denied" }, 401);
    }
    if (request.url === "/api/auth/session") return json(response, {
      authenticated: true, auth: { policy: "loopback-browser", bootstrapMethods: ["one-time-token"],
        sessionMethods: ["bearer-access-token"], sessionCookieName: "t3_session" },
      scopes: ["orchestration:read", "orchestration:operate"], sessionMethod: "bearer-access-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    if (request.url === "/api/orchestration/snapshot") return json(response, {
      snapshotSequence: 1, projects: [{ id: "project-a", title: "Direct project" }], threads: [],
      updatedAt: "2026-09-20T00:00:00.000Z",
    });
    json(response, {}, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  const diagnostics = [];
  async function client(stateDirectory = directory) {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(process.cwd(), "dist/index.js")], cwd: process.cwd(),
      env: { ...process.env, T3_MCP_STATE_DIR: stateDirectory, T3_MCP_CONNECT_RELAY_URL: baseUrl,
        T3_MCP_CONNECT_TOKEN_ENDPOINT: `${baseUrl}/oauth/token`, T3_MCP_CONNECT_CLIENT_ID: "fixture-client",
        ...(options.callbackPort === null ? {} : { T3_MCP_CONNECT_CALLBACK_PORT: options.callbackPort ?? "0" }),
        T3_MCP_CONNECT_HOSTED_APP_URL: "https://app.t3.codes", NODE_NO_WARNINGS: "1" }, stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => diagnostics.push(chunk.toString()));
    const result = new Client({ name: "connect-auth-test", version: "1.0.0" });
    await result.connect(transport);
    clients.push(result);
    return result;
  }
  t.after(async () => {
    await Promise.all(clients.map((entry) => entry.close()));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, baseUrl, client, requests, diagnostics };
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
async function start(client) {
  const result = await call(client, "connect_authenticate");
  assert.equal(result.authentication.status, "pending");
  const url = new URL(result.authentication.authorizationUrl);
  assert.equal(url.pathname, "/connect");
  assert.equal(url.search, "");
  const params = new URLSearchParams(url.hash.slice(1));
  return { params, callback: `http://127.0.0.1:${params.get("port")}/callback?state=${params.get("state")}` };
}
async function login(client) {
  const pending = await start(client);
  const response = await fetch(`${pending.callback}&code=fixture-code`);
  await response.text();
  assert.equal(response.status, 200);
  assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
  return pending;
}

test("expired Connect login reports failure and can recover through browser authentication", async (t) => {
  let exchanges = 0;
  const f = await fixture(t, { exchange: (response) => json(response, token({
    expires_in: ++exchanges === 1 ? 0.001 : 3600, refresh_token: "",
  })) });
  const client = await f.client();
  const pending = await start(client);
  await (await fetch(`${pending.callback}&code=fixture-code`)).text();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = (await call(client, "connect_authenticate", { action: "status" })).authentication;
  assert.equal(status.status, "failed");
  assert.equal(status.error.code, "connect_auth_expired");
  await login(client);
  const exchange = f.requests.find((entry) => entry.path === "/oauth/token");
  assert.equal(createHash("sha256").update(exchange.form.get("code_verifier")).digest("base64url"), pending.params.get("challenge"));
  assert.deepEqual((await call(client, "list_environments")).environments, []);
});

test("refresh cannot silently replace or lose the active Connect account", async (t) => {
  let refreshed = token({ access_token: jwt("account-b"), id_token: jwt("account-b") });
  const f = await fixture(t, {
    exchange: (response) => json(response, token({ expires_in: 30 })),
    refresh: (response) => json(response, refreshed),
  });
  const client = await f.client();
  await login(client);
  assert.equal((await call(client, "list_connect_environments")).error?.code, "connect_account_conflict");
  assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.error?.code, "connect_account_conflict");
  assert.equal(f.requests.filter((entry) => entry.path === "/v1/environments").length, 0);
  refreshed = token({ access_token: "opaque", id_token: "malformed" });
  assert.equal((await call(client, "list_connect_environments")).error?.code, "upstream_incompatible");
  assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.status, "failed");
  refreshed = token({ access_token: jwt("account-b"), id_token: jwt("account-a") });
  assert.equal((await call(client, "list_connect_environments")).error?.code, "upstream_incompatible");
  refreshed = token({ refresh_token: undefined, id_token: undefined });
  assert.equal((await call(client, "list_connect_environments")).environments?.[0].id, "remote-a");
  await client.close();
  const restarted = await f.client();
  assert.equal((await call(restarted, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
  assert.equal((await call(restarted, "list_connect_environments")).environments?.[0].id, "remote-a");
});

test("sign-out wins over an in-flight refresh and survives restart", async (t) => {
  const arrived = deferred();
  const release = deferred();
  const f = await fixture(t, {
    exchange: (response) => json(response, token({ expires_in: 30 })),
    refresh: async (response) => { arrived.resolve(); await release.promise; json(response, token()); },
  });
  t.after(() => release.resolve());
  const client = await f.client();
  await login(client);
  const discovery = call(client, "list_connect_environments");
  await arrived.promise;
  await call(client, "sign_out_connect");
  release.resolve();
  assert.equal((await discovery).error?.code, "connect_auth_cancelled");
  assert.equal(f.requests.some((entry) => entry.path === "/v1/environments"), false);
  assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.status, "signed_out");
  await client.close();
  const restarted = await f.client();
  assert.equal((await call(restarted, "connect_authenticate", { action: "status" })).authentication.status, "signed_out");
});

test("sign-out cancels a late callback without blocking or corrupting a new login", async (t) => {
  const arrived = deferred();
  const release = deferred();
  let exchanges = 0;
  const f = await fixture(t, { exchange: async (response) => {
    if (++exchanges === 1) { arrived.resolve(); await release.promise; }
    json(response, token());
  } });
  const client = await f.client();
  const pending = await start(client);
  const callback = fetch(`${pending.callback}&code=fixture-code`).then((response) => response.text());
  await arrived.promise;
  try {
    const signOut = await Promise.race([
      call(client, "sign_out_connect"),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    assert.notEqual(signOut, null, "sign-out must not wait for the token exchange");
    const next = await start(client);
    release.resolve();
    await callback;
    assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.authorizationUrl,
      `https://app.t3.codes/connect#${next.params}`);
    await (await fetch(`${next.callback}&code=fixture-code`)).text();
    assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
  } finally { release.resolve(); await callback; }
});

test("malformed token responses fail safely and leave authentication recoverable", async (t) => {
  let reply;
  const f = await fixture(t, { exchange: (response) => json(response, reply) });
  const client = await f.client();
  for (const malformed of [
    token({ access_token: "" }), token({ token_type: "DPoP" }), token({ token_type: undefined }),
    token({ refresh_token: 42 }), token({ expires_in: 1e100 }), token({ expires_in: -1 }),
    token({ id_token: "malformed" }), [], null,
  ]) {
    reply = malformed;
    const pending = await start(client);
    await (await fetch(`${pending.callback}&code=fixture-code`)).text();
    const status = (await call(client, "connect_authenticate", { action: "status" })).authentication;
    assert.equal(status.status, "failed", "malformed OAuth responses must not authenticate");
    assert.equal(status.error.code, "connect_auth_failed");
    assert.equal(JSON.stringify(status).includes("fixture-refresh"), false);
  }
  reply = token();
  await login(client);
});

test("discovery rejects credential reflection and malformed metadata without registering targets", async (t) => {
  let discovered;
  const f = await fixture(t, { discover: (response) => json(response, { environments: [discovered] }) });
  const client = await f.client();
  await login(client);
  for (const unsafe of [
    record({ label: `Remote ${jwt("account-a")}` }),
    record({ environmentId: "fixture-refresh" }), record({ linkedAt: "fixture-refresh" }),
    record({ endpoint: { httpBaseUrl: "https://fixture-refresh.example", wsBaseUrl: "wss://safe.example", providerKind: "manual" } }),
    record({ endpoint: { httpBaseUrl: "https://remote.example", wsBaseUrl: "wss://fixture-refresh.example", providerKind: "manual" } }),
    record({ label: "" }), record({ linkedAt: "" }),
  ]) {
    discovered = unsafe;
    const result = await call(client, "list_connect_environments");
    assert.equal(result.error?.code, "upstream_incompatible");
    assert.equal(JSON.stringify(result).includes("fixture-refresh"), false);
    assert.equal(JSON.stringify(result).includes(jwt("account-a")), false);
  }
  discovered = record();
  assert.equal((await call(client, "list_connect_environments")).environments[0].id, "remote-a");
  assert.deepEqual((await call(client, "list_environments")).environments, []);
  assert.equal((await call(client, "list_projects", { environmentId: "remote-a" })).error.code, "environment_not_found");
  assert.equal(f.diagnostics.join("").includes("fixture-refresh"), false);
});

test("rejected refresh or relay authentication reports expiry and preserves the account during recovery", async (t) => {
  let exchange = token({ expires_in: 30 });
  let relayStatus = 200;
  const f = await fixture(t, {
    exchange: (response) => json(response, exchange),
    refresh: (response) => json(response, { error: "invalid_grant", error_description: "fixture-refresh" }, 400),
    discover: (response) => json(response, { environments: [] }, relayStatus),
  });
  const client = await f.client();
  await login(client);
  assert.equal((await call(client, "list_connect_environments")).error.code, "connect_auth_expired");
  assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.error?.code, "connect_auth_expired");
  exchange = token({ access_token: jwt("account-b"), id_token: jwt("account-b") });
  let pending = await start(client);
  await (await fetch(`${pending.callback}&code=fixture-code`)).text();
  assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.error.code, "connect_account_conflict");
  exchange = token();
  await login(client);
  relayStatus = 401;
  assert.equal((await call(client, "list_connect_environments")).error.code, "connect_auth_expired");
  assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.error?.code, "connect_auth_expired");
  await call(client, "sign_out_connect");
  await login(client);
  assert.equal((await stat(path.join(f.directory, "connect.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
});

test("browser cancellation, denial, and invalid callbacks have sanitized, recoverable outcomes", async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  let pending = await start(client);
  assert.equal((await fetch(`${pending.callback.replace(/state=[^&]+/, "state=wrong")}&code=fixture-code`)).status, 400);
  assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.status, "pending");
  assert.equal((await fetch(`${pending.callback}&code=fixture-code`, { method: "POST" })).status, 405);
  await call(client, "connect_authenticate", { action: "cancel" });
  assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.status, "cancelled");
  assert.equal(f.requests.length, 0);
  for (const [query, code] of [
    ["error=access_denied&error_description=fixture-refresh", "connect_auth_failed"],
    ["error=expired_token", "connect_auth_expired"],
    ["", "connect_auth_failed"],
    ["code=one&code=two", "connect_auth_failed"],
  ]) {
    pending = await start(client);
    const callback = await fetch(`${pending.callback}&${query}`);
    assert.equal((await callback.text()).includes("fixture-refresh"), false);
    const outcome = (await call(client, "connect_authenticate", { action: "status" })).authentication;
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error.code, code);
  }
  await login(client);
});

test("concurrent discovery shares one refresh instead of replaying a rotating refresh token", async (t) => {
  const arrived = deferred();
  const release = deferred();
  let refreshes = 0;
  const f = await fixture(t, {
    exchange: (response) => json(response, token({ expires_in: 30 })),
    refresh: async (response) => {
      if (++refreshes > 1) return json(response, { error: "invalid_grant" }, 400);
      arrived.resolve(); await release.promise; json(response, token({ refresh_token: "rotated-refresh" }));
    },
  });
  const client = await f.client();
  await login(client);
  const results = [call(client, "list_connect_environments"), call(client, "list_connect_environments")];
  await arrived.promise;
  await call(client, "connect_authenticate", { action: "status" });
  release.resolve();
  for (const result of await Promise.all(results)) assert.equal(result.environments?.[0].id, "remote-a");
  assert.equal(refreshes, 1);
});

test("Connect restart, rejection, and sign-out preserve separately saved direct sessions", async (t) => {
  let unavailable = false;
  const f = await fixture(t, { discover: (response) => json(response,
    unavailable ? { error: "fixture-refresh" } : { environments: [record()] }, unavailable ? 503 : 200) });
  const client = await f.client();
  assert.equal((await call(client, "add_environment", { endpoint: f.baseUrl, grant: "direct-bootstrap" })).environment.id, "direct-a");
  await login(client);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(f.directory, "connect.json"))).mode & 0o777, 0o600);
  await client.close();
  const restarted = await f.client();
  assert.equal((await call(restarted, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
  assert.equal((await call(restarted, "list_connect_environments")).environments[0].id, "remote-a");
  unavailable = true;
  assert.equal((await call(restarted, "list_connect_environments")).error.code, "connect_unavailable");
  const before = (await call(restarted, "list_environments")).environments;
  assert.equal(before.length, 1);
  assert.deepEqual((await call(restarted, "sign_out_connect")), { signedOut: true });
  assert.deepEqual((await call(restarted, "sign_out_connect")), { signedOut: false });
  assert.deepEqual((await call(restarted, "list_environments")).environments, before);
  assert.deepEqual((await call(restarted, "list_projects", { environmentId: "direct-a" })).projects,
    [{ id: "project-a", name: "Direct project" }]);
  await restarted.close();
  const afterSignOut = await f.client();
  assert.equal((await call(afterSignOut, "connect_authenticate", { action: "status" })).authentication.status, "signed_out");
  assert.deepEqual((await call(afterSignOut, "list_projects", { environmentId: "direct-a" })).projects,
    [{ id: "project-a", name: "Direct project" }]);
});

test("Connect storage rejects invalid expiry and unsafe file permissions with sanitized errors", async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  await login(client);
  const file = path.join(f.directory, "connect.json");
  const saved = await readFile(file, "utf8");
  const corrupted = JSON.parse(saved);
  corrupted.auth.expiresAt = "not-a-date";
  await writeFile(file, JSON.stringify(corrupted));
  let status = await call(client, "connect_authenticate", { action: "status" });
  assert.equal(status.error?.code, "storage_error");
  assert.equal(JSON.stringify(status).includes(f.directory), false);
  await writeFile(file, saved);
  await chmod(file, 0o644);
  status = await call(client, "connect_authenticate", { action: "status" });
  assert.equal(status.error.code, "storage_error");
  await chmod(file, 0o600);
  assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
  const local = await f.client(process.cwd());
  assert.equal((await call(local, "connect_authenticate")).error.code, "storage_error");
});

test("browser login defaults to the pinned upstream callback port", async (t) => {
  const f = await fixture(t, { callbackPort: null });
  const client = await f.client();
  const pending = await start(client);
  assert.equal(pending.params.get("port"), "34338");
  await call(client, "connect_authenticate", { action: "cancel" });
});

test("a retained login without account identity requires sign-out before browser recovery", async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  await login(client);
  const file = path.join(f.directory, "connect.json");
  const legacy = JSON.parse(await readFile(file, "utf8"));
  delete legacy.auth.accountId;
  legacy.auth.expiresAt = "1970-01-01T00:00:00.000Z";
  legacy.auth.refreshToken = "";
  await writeFile(file, JSON.stringify(legacy));
  const pending = await start(client);
  await (await fetch(`${pending.callback}&code=fixture-code`)).text();
  assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.error?.code, "connect_account_conflict");
  await call(client, "sign_out_connect");
  await login(client);
});

for (const recovery of [false, true]) {
  test(`cancelling an in-progress auth write survives restart${recovery ? " and preserves the retained recovery login" : ""}`, { timeout: 30_000 }, async (t) => {
    let reply = token({ expires_in: 30 });
    const f = await fixture(t, {
      exchange: (response) => json(response, reply),
      refresh: (response) => json(response, { error: "temporary_failure" }, 400),
      discover: (response, request) => json(response, { environments: [record()] }, request.headers.authorization === `Bearer ${jwt("account-a")}` ? 200 : 401),
    });
    const client = await f.client();
    if (recovery) await login(client);
    const pending = await start(client);
    if (recovery) {
      const file = path.join(f.directory, "connect.json");
      const retained = JSON.parse(await readFile(file, "utf8"));
      retained.auth.expiresAt = new Date(Date.now() + 3600_000).toISOString();
      await writeFile(file, JSON.stringify(retained));
    }
    // A large controlled response keeps the real atomic write in flight long enough
    // to cancel over MCP after the OS reports temporary-file creation.
    reply = token({ access_token: `${jwt("account-a")}rotated`, refresh_token: "r".repeat(64 * 1024 * 1024) });
    const writing = deferred();
    const watcher = watch(f.directory, (event, name) => {
      if (name?.startsWith(".connect-") && name.endsWith(".tmp")) writing.resolve();
    });
    t.after(() => watcher.close());
    const callback = fetch(`${pending.callback}&code=fixture-code`).then((response) => response.text());
    await writing.promise;
    assert.equal((await call(client, "connect_authenticate", { action: "cancel" })).authentication.status, "cancelled");
    await callback;
    await client.close();
    const restarted = await f.client();
    const status = (await call(restarted, "connect_authenticate", { action: "status" })).authentication;
    assert.equal(status.status, recovery ? "authenticated" : "signed_out");
    if (recovery) {
      assert.equal((await call(restarted, "list_connect_environments")).environments?.[0].id, "remote-a");
    }
  });
}

test("a held discovery 401 cannot retire newer rotated credentials", async (t) => {
  const arrived = deferred();
  const release = deferred();
  const rotated = `${jwt("account-a")}rotated`;
  let discoveries = 0;
  const f = await fixture(t, {
    refresh: (response) => json(response, token({ access_token: rotated, refresh_token: "rotated-refresh" })),
    discover: async (response, request) => {
      if (++discoveries === 1) { arrived.resolve(); await release.promise; return json(response, {}, 401); }
      json(response, { environments: [record()] }, request.headers.authorization === `Bearer ${rotated}` ? 200 : 401);
    },
  });
  t.after(release.resolve);
  const client = await f.client();
  await login(client);
  const stale = call(client, "list_connect_environments");
  await arrived.promise;
  const file = path.join(f.directory, "connect.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.auth.expiresAt = new Date(Date.now() + 30_000).toISOString();
  await writeFile(file, JSON.stringify(saved));
  assert.equal((await call(client, "list_connect_environments")).environments?.[0].id, "remote-a");
  release.resolve();
  assert.equal((await stale).error?.code, "connect_auth_expired");
  assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
  assert.equal((await call(client, "list_connect_environments")).environments?.[0].id, "remote-a");
  await client.close();
  const restarted = await f.client();
  assert.equal((await call(restarted, "list_connect_environments")).environments?.[0].id, "remote-a");
});

test("opaque refresh without identity retains the pinned account but supplied changed identity is rejected", async (t) => {
  let refreshed = token({ access_token: "opaque-refreshed", id_token: undefined });
  const f = await fixture(t, {
    exchange: (response) => json(response, token({ access_token: "opaque-initial", expires_in: 30 })),
    refresh: (response) => json(response, refreshed),
  });
  const client = await f.client();
  await login(client);
  assert.equal((await call(client, "list_connect_environments")).environments?.[0].id, "remote-a");
  assert.equal((await call(client, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
  const file = path.join(f.directory, "connect.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.auth.expiresAt = new Date(Date.now() + 30_000).toISOString();
  await writeFile(file, JSON.stringify(saved));
  refreshed = token({ access_token: "opaque-other", id_token: jwt("account-b") });
  assert.equal((await call(client, "list_connect_environments")).error?.code, "connect_account_conflict");
  await client.close();
  const restarted = await f.client();
  refreshed = token({ access_token: "opaque-again", id_token: undefined });
  assert.equal((await call(restarted, "list_connect_environments")).environments?.[0].id, "remote-a");
});
