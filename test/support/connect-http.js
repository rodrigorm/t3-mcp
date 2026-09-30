import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const ACCESS_TYPE = "urn:ietf:params:oauth:token-type:access_token";
export const EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const SCOPES = "orchestration:read orchestration:operate";
const relayKey = generateKeyPairSync("ed25519");
const clerkKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("base64url");

function jwt(header, claims) {
  const input = `${encode(header)}.${encode(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), relayKey.privateKey).toString("base64url")}`;
}

// Controlled Clerk session-template issuer. The relay verifies its signature independently.
export function relaySubjectJwt(audience = "t3-code-relay", subject = "connect-account-a", lifetime = 3600, extraClaims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: "https://fixture.clerk.test", sub: subject, aud: audience, iat: now, exp: now + lifetime, ...extraClaims })}`;
  return `${input}.${sign("sha256", Buffer.from(input), clerkKey.privateKey).toString("base64url")}`;
}

function verifyJwt(token) {
  const [header, payload, signature, extra] = token.split(".");
  assert.equal(extra, undefined);
  assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
  assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), clerkKey.publicKey, Buffer.from(signature, "base64url")));
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, "https://fixture.clerk.test");
  assert.ok(claims.sub && claims.exp > Date.now() / 1000);
  return claims;
}

// Independent verifier of the pinned shared DPoP contract, not the connector's signer.
export function verifyDpop(request, origin, replay, { token, thumbprint } = {}) {
  const proof = request.headers.dpop;
  assert.equal(typeof proof, "string");
  const [headerPart, claimsPart, signaturePart, extra] = proof.split(".");
  assert.equal(extra, undefined);
  const header = JSON.parse(Buffer.from(headerPart, "base64url"));
  const claims = JSON.parse(Buffer.from(claimsPart, "base64url"));
  assert.equal(header.typ, "dpop+jwt");
  assert.equal(header.alg, "ES256");
  const { jwk } = header;
  assert.equal(jwk.kty, "EC");
  assert.equal(jwk.crv, "P-256");
  assert.equal(jwk.d, undefined);
  assert.equal(Buffer.from(jwk.x, "base64url").length, 32);
  assert.equal(Buffer.from(jwk.y, "base64url").length, 32);
  const signature = Buffer.from(signaturePart, "base64url");
  assert.equal(signature.length, 64);
  assert.ok(verify("sha256", Buffer.from(`${headerPart}.${claimsPart}`), {
    key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363",
  }, signature));
  const url = new URL(request.url, origin);
  url.search = "";
  url.hash = "";
  assert.equal(claims.htu, url.toString());
  assert.equal(claims.htm, request.method);
  assert.equal(typeof claims.jti, "string");
  assert.ok(claims.jti.trim());
  assert.ok(Number.isInteger(claims.iat));
  const now = Math.floor(Date.now() / 1000);
  assert.ok(claims.iat <= now + 5 && claims.iat >= now - 300);
  if (token !== undefined) assert.equal(claims.ath, hash(token));
  const jkt = hash(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
  if (thumbprint !== undefined) assert.equal(jkt, thumbprint);
  const replayKey = `${jkt}:${claims.jti}`;
  assert.equal(replay.has(replayKey), false);
  replay.add(replayKey);
  return jkt;
}

export function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

export async function http(handler) {
  // Permit the signed large-template storage-race fixture. Proof/credential checks
  // below remain strict; production services keep their own HTTP size limits.
  const server = createServer({ maxHeaderSize: 32 * 1024 * 1024 }, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      await handler(request, response, Buffer.concat(chunks).toString("utf8"));
    } catch {
      // Never print requests, proof keys, credentials, or assertion values from auth validation.
      if (!response.headersSent) json(response, { code: "fixture_contract_rejected" }, 401);
      else response.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

export async function startConnectControl(environments, options = {}) {
  const state = { accessToken: relaySubjectJwt(), ...options };
  const clerkRequests = [];
  const relayRequests = [];
  const replay = new Set();
  const relayTokens = new Map();
  const clients = new Map();
  let clientCount = 0;
  let rotation = 0;
  const session = (owner) => ({ id: owner.sessionId, status: state.sessionStatus ?? "active",
    expire_at: state.sessionExpiresAt ?? Date.now() + 3600_000, user: { id: state.accountId ?? "connect-account-a" },
    tasks: state.tasks ?? [] });
  const client = (owner) => ({ id: owner.id, sessions: owner.authenticated ? [session(owner)] : [], last_active_session_id: owner.authenticated ? owner.sessionId : null });
  const attempt = (owner, status) => ({ id: "si_owned", status,
    supported_first_factors: state.firstFactors ?? [{ strategy: "email_code", email_address_id: "email_owned" }, { strategy: "password" }],
    supported_second_factors: state.secondFactors ?? [{ strategy: "totp" }],
    created_session_id: status === "complete" ? owner.sessionId : null,
    ...(state.protectCheck ? { protect_check: state.protectCheck } : {}) });
  const clerk = await http(async (request, response, body) => {
    const url = new URL(request.url, "http://fixture");
    clerkRequests.push({ method: request.method, path: url.pathname, query: url.searchParams, headers: request.headers, body });
    const form = new URLSearchParams(body);
    assert.equal(url.searchParams.get("_is_native"), "1");
    assert.equal(url.searchParams.get("__clerk_api_version"), "2026-05-12");
    assert.equal(request.headers.origin, undefined);
    assert.equal(request.headers.cookie, undefined);
    let owner;
    if (url.pathname === "/v1/client" && request.method === "POST") {
      const n = ++clientCount;
      owner = { id: `client_owned_${n}`, sessionId: n === 1 ? "sess_owned" : `sess_owned_${n}`, authenticated: false };
    } else {
      const previous = request.headers.authorization?.replace(/^Bearer /, "");
      owner = clients.get(previous);
      assert.ok(owner);
      clients.delete(previous);
    }
    const credential = `native-client-secret-${++rotation}`;
    clients.set(credential, owner);
    state.nativeClientToken = credential;
    response.setHeader("authorization", rotation % 2 ? `Bearer ${credential}` : credential);
    await state.beforeClerk?.(url.pathname, request.method);
    if (state.clerkStatus) return json(response, { errors: [{ code: "session_not_found", message: credential }] }, state.clerkStatus);
    const reply = (value) => json(response, { response: value, client: client(owner) });
    if (url.pathname === "/v1/client") return reply(state.clientResponse ?? client(owner));
    if (url.pathname === "/v1/client/sign_ins") {
      assert.equal(form.get("identifier"), "operator@example.test");
      return reply(attempt(owner, state.signInStatus ?? "needs_first_factor"));
    }
    if (url.pathname.endsWith("/prepare_first_factor")) {
      assert.equal(form.get("strategy"), "email_code");
      assert.equal(form.get("email_address_id"), "email_owned");
      return reply(attempt(owner, "needs_first_factor"));
    }
    if (url.pathname.endsWith("/attempt_first_factor")) {
      if (state.rejectVerify) return json(response, { errors: [{ code: "form_code_incorrect", message: credential,
        long_message: "operator-password reflected" }] }, 422);
      assert.ok(form.get("code") === "123456" || form.get("password") === "operator-password");
      const status = state.afterFirstFactor ?? "complete";
      owner.authenticated = status === "complete";
      return reply(attempt(owner, status));
    }
    if (url.pathname.endsWith("/prepare_second_factor")) return reply(attempt(owner, state.afterFirstFactor));
    if (url.pathname.endsWith("/attempt_second_factor")) {
      assert.equal(form.get("code"), "654321");
      owner.authenticated = true;
      return reply(attempt(owner, "complete"));
    }
    if (url.pathname.endsWith("/end")) { owner.authenticated = false; return reply({ ...session(owner), status: "ended" }); }
    if (url.pathname.endsWith("/tokens/t3-relay")) {
      assert.ok(owner.authenticated);
      assert.equal(body, "");
      if (state.templateLifetime) state.accessToken = relaySubjectJwt("t3-code-relay", state.accountId ?? "connect-account-a", state.templateLifetime);
      // Template tokens are a direct { jwt } response in the public OpenAPI.
      return json(response, Object.hasOwn(state, "templateResponse") ? state.templateResponse : { jwt: state.accessToken });
    }
    if (url.pathname.startsWith(`/v1/client/sessions/${owner.sessionId}`)) { assert.ok(owner.authenticated); return reply(state.sessionResponse ?? session(owner)); }
    return json(response, {}, 404);
  });
  const endpoint = (environment) => ({ httpBaseUrl: environment.baseUrl,
    wsBaseUrl: environment.baseUrl.replace(/^http/, "ws"), providerKind: "cloudflare_tunnel" });
  const relay = await http(async (request, response, body) => {
    relayRequests.push({ method: request.method, path: request.url, headers: request.headers, body });
    if (state.outage) return json(response, { code: "unavailable", secret: state.accessToken }, 503);
    if (request.method === "GET" && request.url === "/v1/environments") {
      await state.beforeDiscovery?.();
      assert.equal(request.headers.authorization, `Bearer ${state.accessToken}`);
      const identity = verifyJwt(state.accessToken);
      assert.ok([identity.aud].flat().includes("t3-code-relay"));
      return json(response, { environments: state.environments ?? environments.map((environment) => ({ environmentId: environment.id,
        label: environment.label ?? environment.id, endpoint: endpoint(environment), linkedAt: "2026-09-20T00:00:00.000Z" })) }, state.discoveryStatus ?? 200);
    }
    if (request.method === "POST" && request.url === "/v1/client/dpop-token") {
      await state.beforeRelayExchange?.();
      if (state.relayStatus) return json(response, { code: "auth_invalid", secret: state.accessToken }, state.relayStatus);
      const form = new URLSearchParams(body);
      assert.equal(form.get("grant_type"), EXCHANGE);
      assert.equal(form.get("subject_token_type"), "urn:ietf:params:oauth:token-type:jwt");
      assert.equal(form.get("requested_token_type"), ACCESS_TYPE);
      assert.equal(form.get("resource"), relay.baseUrl);
      assert.equal(form.get("scope"), "environment:connect");
      assert.ok(["t3-web", "t3-mobile"].includes(form.get("client_id")));
      const subject = verifyJwt(form.get("subject_token"));
      assert.ok([subject.aud].flat().includes("t3-code-relay"));
      const jkt = verifyDpop(request, relay.baseUrl, replay);
      const now = Math.floor(Date.now() / 1000);
      const token = jwt({ alg: "EdDSA", typ: "t3-relay-dpop-access+jwt" }, {
        iss: relay.baseUrl, aud: relay.baseUrl, sub: subject.sub, jti: randomUUID(), iat: now, exp: now + 1800,
        client_id: form.get("client_id"), scope: "environment:connect", cnf: { jkt },
      });
      relayTokens.set(token, jkt);
      return json(response, state.relayResponse ?? { access_token: token, issued_token_type: ACCESS_TYPE,
        token_type: "DPoP", expires_in: 1800, scope: "environment:connect", ...state.relayOverrides });
    }
    const match = request.url?.match(/^\/v1\/environments\/([^/]+)\/connect$/);
    if (request.method === "POST" && match) {
      await state.beforeConnect?.();
      const token = request.headers.authorization?.replace(/^DPoP /, "");
      const jkt = relayTokens.get(token);
      assert.ok(jkt);
      verifyDpop(request, relay.baseUrl, replay, { token, thumbprint: jkt });
      assert.equal(JSON.parse(body).clientProofKeyThumbprint, jkt);
      const environment = environments.find((entry) => entry.id === decodeURIComponent(match[1]));
      if (!environment) return json(response, { code: "not_found" }, 404);
      // Model an active link and a ready managed allocation. No arbitrary/manual destinations.
      if (environment.ready === false) return json(response, { code: "environment_connect_not_authorized" }, 403);
      const target = environment.connectTarget ?? environment;
      const credential = target.mint ? target.mint(jkt) : environment.connectGrant;
      target.bindBootstrap?.(credential, jkt);
      return json(response, state.connectResponse ?? { environmentId: environment.id, endpoint: endpoint(target),
        credential, expiresAt: new Date(Date.now() + 120_000).toISOString(), ...state.connectOverrides });
    }
    json(response, { code: "not_found" }, 404);
  });
  return { state, clerkRequests, relayRequests,
    env: { T3_MCP_CONNECT_RELAY_URL: relay.baseUrl, T3_MCP_CONNECT_FRONTEND_API_URL: clerk.baseUrl,
    T3_MCP_CONNECT_CALLBACK_PORT: "0" },
  close: async () => { await clerk.close(); await relay.close(); } };
}

export async function startConnectEnvironment(id, options = {}) {
  const state = { label: id, descriptorId: id, readStatus: 200, expiresIn: 3600, ...options };
  const requests = [];
  const commands = [];
  const grants = new Map();
  const sessions = new Map();
  const replay = new Set();
  const threads = new Map();
  const server = await http(async (request, response, body) => {
    requests.push({ method: request.method, path: request.url, headers: request.headers, body });
    if (request.method === "GET" && request.url === "/.well-known/t3/environment") {
      await state.beforeDescriptor?.();
      return json(response, state.descriptor ?? { environmentId: state.descriptorId, label: state.label,
        platform: { os: "linux", arch: "x64" }, serverVersion: "0.0.42", orchestrationProtocolVersion: 1,
        capabilities: {}, ...state.descriptorOverrides });
    }
    if (request.method === "POST" && request.url === "/oauth/token") {
      const form = new URLSearchParams(body);
      assert.equal(form.get("grant_type"), EXCHANGE);
      assert.equal(form.get("subject_token_type"), "urn:t3:params:oauth:token-type:environment-bootstrap");
      assert.equal(form.get("requested_token_type"), ACCESS_TYPE);
      assert.equal(form.get("scope"), SCOPES);
      assert.equal(form.has("resource"), false);
      await state.beforeExchange?.(form);
      const grant = form.get("subject_token");
      const binding = grants.get(grant);
      if (state.rejectGrant || (grant !== "direct-grant" && !binding)) {
        return json(response, { code: "auth_invalid", credential: grant }, 401);
      }
      const jkt = binding ? verifyDpop(request, server.baseUrl, replay, { thumbprint: binding.jkt }) : undefined;
      if (binding) {
        assert.ok(binding.expiresAt > Date.now());
        grants.delete(grant);
      }
      const token = `${encode({ kind: "session", sid: randomUUID() })}.${hash(randomUUID())}`;
      sessions.set(token, { jkt, expiresAt: Date.now() + state.expiresIn * 1000 });
      return json(response, state.tokenResponse ?? { access_token: token, issued_token_type: ACCESS_TYPE,
        token_type: jkt ? "DPoP" : "Bearer", expires_in: state.expiresIn, scope: SCOPES, ...state.tokenOverrides });
    }
    const [type, token] = request.headers.authorization?.split(" ") ?? [];
    const session = sessions.get(token);
    if (!session || session.expiresAt <= Date.now() || type !== (session.jkt ? "DPoP" : "Bearer")) {
      return json(response, { code: "auth_invalid", secret: "fixture-session-secret" }, 401);
    }
    if (session.jkt) verifyDpop(request, server.baseUrl, replay, { token, thumbprint: session.jkt });
    if (request.method === "GET" && request.url === "/api/auth/session") {
      await state.beforeSession?.();
      return json(response, state.sessionResponse ?? { authenticated: true,
        auth: { policy: "loopback-browser", bootstrapMethods: ["one-time-token"],
          sessionMethods: [session.jkt ? "dpop-access-token" : "bearer-access-token"], sessionCookieName: "t3_session" },
        scopes: SCOPES.split(" "), sessionMethod: session.jkt ? "dpop-access-token" : "bearer-access-token",
        expiresAt: new Date(session.expiresAt).toISOString(), ...state.sessionOverrides });
    }
    if (request.method === "GET") {
      if (state.readDrop) return request.socket.destroy();
      if (state.readStatus !== 200) return json(response, { code: "denied", secret: token }, state.readStatus);
      const url = new URL(request.url, server.baseUrl);
      if (url.pathname === "/api/orchestration/snapshot") {
        const snapshot = { snapshotSequence: commands.length, projects: [{ id: "project", title: state.label,
          defaultModelSelection: { instanceId: "fixture", model: "model" } }], threads: [], updatedAt: new Date().toISOString() };
        return json(response, state.projectSnapshot?.(snapshot, token) ?? snapshot);
      }
      if (url.pathname.startsWith("/api/orchestration/threads/")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1));
        const thread = threads.get(id);
        if (!thread) return json(response, { code: "thread_not_found" }, 404);
        const snapshot = { snapshotSequence: commands.length, thread: { ...thread,
          latestTurn: { state: state.threadState ?? "completed" }, session: { status: "ready" }, activities: state.activities ?? [] },
        page: { beforeCursor: null, hasMore: false, snapshotSequence: commands.length } };
        return json(response, state.threadSnapshot?.(snapshot, token) ?? snapshot);
      }
    }
    if (request.method === "POST" && request.url === "/api/orchestration/dispatch") {
      const command = JSON.parse(body);
      commands.push(command);
      const fault = state.dispatch?.(command, commands.length);
      if (fault?.drop) return request.socket.destroy();
      if (fault?.status) return json(response, fault.body, fault.status);
      if (fault?.body) return json(response, fault.body);
      if (command.type === "thread.create") {
        threads.set(command.threadId, { id: command.threadId, projectId: command.projectId, title: command.title, messages: [] });
      } else {
        const thread = threads.get(command.threadId);
        assert.ok(thread);
        const now = new Date().toISOString();
        thread.messages.push({ id: command.message.messageId, role: "user", text: command.message.text,
          turnId: command.commandId, streaming: false, createdAt: now, updatedAt: now },
        { id: randomUUID(), role: "assistant", text: `result ${thread.messages.length / 2 + 1}`,
          turnId: command.commandId, streaming: false, createdAt: now, updatedAt: now });
      }
      return json(response, { sequence: commands.length });
    }
    json(response, { code: "not_found" }, 404);
  });
  return { ...server, id, label: state.label, state, requests, commands, sessions, threads,
    mint(jkt) {
      const grant = `bootstrap-${randomUUID()}`;
      grants.set(grant, { jkt, expiresAt: Date.now() + 120_000 });
      return grant;
    } };
}

export function content(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
export async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}
export function success(result) {
  assert.equal(result.isError, undefined, content(result).error?.message);
  return content(result);
}
export function failure(result, code) {
  assert.equal(result.isError, true);
  assert.equal(content(result).error.code, code);
}
export async function login(client, control) {
  const auth = success(await call(client, "connect_authenticate")).authentication;
  assert.equal(auth.status, "pending");
  await operatorLogin(auth.authorizationUrl);
  assert.equal(success(await call(client, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
}

export async function operatorPost(authorizationUrl, action, fields = {}, headers = {}) {
  const url = new URL(authorizationUrl);
  return fetch(`${url.origin}/login`, { method: "POST", headers: { origin: url.origin,
    "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ capability: url.hash.slice(1), action, ...fields }) });
}
export async function operatorLogin(url) {
  assert.equal((await operatorPost(url, "identify", { identifier: "operator@example.test" })).status, 200);
  const response = await operatorPost(url, "verify", { code: "123456" });
  assert.equal(response.status, 200);
  return response;
}

export async function fixture(t, environments = [], options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-connect-http-"));
  const control = await startConnectControl(environments, options);
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await control.close();
    await Promise.all(environments.map((environment) => environment.close?.()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, control, async client(connectorPath = path.join(process.cwd(), "dist/index.js")) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [connectorPath], cwd: process.cwd(),
      env: { ...process.env, ...control.env, T3_MCP_STATE_DIR: directory }, stderr: "pipe" });
    let stderr = "";
    transport.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const client = new Client({ name: "connect-http-test", version: "1.0.0" });
    await client.connect(transport);
    clients.push(client);
    return { client, stderr: () => stderr };
  } };
}
