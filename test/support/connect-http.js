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

// Controlled OAuth issuer can supply this subject. Hosted T3 OAuth has no verified such handoff.
export function relaySubjectJwt(audience = "t3-code-relay", subject = "connect-account-a") {
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: "https://fixture.clerk.test", sub: subject, aud: audience, iat: now, exp: now + 3600 })}`;
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
  assert.equal(claims.htm.toUpperCase(), request.method);
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
  const server = createServer(async (request, response) => {
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
  const state = { accessToken: relaySubjectJwt(), expiresIn: 3600, refresh: true, ...options };
  const clerkRequests = [];
  const relayRequests = [];
  const replay = new Set();
  const relayTokens = new Map();
  const codes = new Map();
  const clerk = await http((request, response, body) => {
    clerkRequests.push({ method: request.method, path: request.url, body });
    const form = new URLSearchParams(body);
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/oauth/token");
    assert.equal(form.get("client_id"), "fixture-client");
    if (form.get("grant_type") === "authorization_code") {
      const authorized = codes.get(form.get("code"));
      assert.ok(authorized);
      codes.delete(form.get("code"));
      assert.equal(hash(form.get("code_verifier")), authorized.challenge);
      assert.equal(form.get("redirect_uri"), authorized.redirect);
    } else {
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "fixture-refresh");
      if (!state.refresh) return json(response, { error: "invalid_grant" }, 400);
    }
    return json(response, { access_token: state.accessToken, token_type: "Bearer", expires_in: state.expiresIn,
      ...(state.refresh ? { refresh_token: "fixture-refresh" } : {}),
      id_token: relaySubjectJwt("fixture-client") });
  });
  const endpoint = (environment) => ({ httpBaseUrl: environment.baseUrl,
    wsBaseUrl: environment.baseUrl.replace(/^http/, "ws"), providerKind: "cloudflare_tunnel" });
  const relay = await http((request, response, body) => {
    relayRequests.push({ method: request.method, path: request.url, headers: request.headers, body });
    if (state.outage) return json(response, { code: "unavailable", secret: state.accessToken }, 503);
    if (request.method === "GET" && request.url === "/v1/environments") {
      assert.equal(request.headers.authorization, `Bearer ${state.accessToken}`);
      return json(response, { environments: environments.map((environment) => ({ environmentId: environment.id,
        label: environment.label ?? environment.id, endpoint: endpoint(environment), linkedAt: "2026-09-20T00:00:00.000Z" })) });
    }
    if (request.method === "POST" && request.url === "/v1/client/dpop-token") {
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
  return { state, clerkRequests, relayRequests, authorize(fragment, code = "browser-code") {
    codes.set(code, { challenge: fragment.get("challenge"), redirect: `http://127.0.0.1:${fragment.get("port")}/callback` });
  }, env: { T3_MCP_CONNECT_RELAY_URL: relay.baseUrl, T3_MCP_CONNECT_TOKEN_ENDPOINT: `${clerk.baseUrl}/oauth/token`,
    T3_MCP_CONNECT_CLIENT_ID: "fixture-client", T3_MCP_CONNECT_HOSTED_APP_URL: "https://app.t3.codes",
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
        return json(response, { snapshotSequence: commands.length, projects: [{ id: "project", title: state.label,
          defaultModelSelection: { instanceId: "fixture", model: "model" } }], threads: [], updatedAt: new Date().toISOString() });
      }
      if (url.pathname.startsWith("/api/orchestration/threads/")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1));
        const thread = threads.get(id);
        if (!thread) return json(response, { code: "thread_not_found" }, 404);
        return json(response, { snapshotSequence: commands.length, thread: { ...thread,
          latestTurn: { state: state.threadState ?? "completed" }, session: { status: "ready" }, activities: state.activities ?? [] },
        page: { beforeCursor: null, hasMore: false, snapshotSequence: commands.length } });
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
  const fragment = new URLSearchParams(new URL(auth.authorizationUrl).hash.slice(1));
  control.authorize(fragment);
  const response = await fetch(`http://127.0.0.1:${fragment.get("port")}/callback?state=${encodeURIComponent(fragment.get("state"))}&code=browser-code`);
  assert.equal(response.status, 200);
  assert.equal(success(await call(client, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
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
