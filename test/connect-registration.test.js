import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { call, content, failure, fixture, login, relaySubjectJwt, startConnectEnvironment, success } from "./support/connect-http.js";

test("reports incompatible OAuth subjects without requesting a relay session or exposing credentials", async (t) => {
  for (const accessToken of ["opaque-oauth-secret", relaySubjectJwt("oauth-client")]) {
    const f = await fixture(t, [{ id: "remote", baseUrl: "http://127.0.0.1:1" }], { accessToken });
    const { client, stderr } = await f.client();
    await login(client, f.control);
    assert.equal(success(await call(client, "list_connect_environments")).environments.length, 1);
    const result = await call(client, "register_connect_environment", { environmentId: "remote" });
    failure(result, "upstream_incompatible");
    assert.match(content(result).error.message, /relay.*JWT|JWT.*relay/);
    assert.match(content(result).error.message, /direct pairing/i);
    assert.equal(JSON.stringify(result).includes(accessToken), false);
    assert.equal(stderr().includes(accessToken), false);
    assert.deepEqual(success(await call(client, "list_environments")).environments, []);
    assert.equal(f.control.relayRequests.some((request) => request.path === "/v1/client/dpop-token"), false);
  }
});

test("rejects reflected bootstrap credentials in environment metadata without emitting or persisting them", async (t) => {
  const remote = await startConnectEnvironment("remote");
  const mint = remote.mint;
  let credential;
  remote.mint = (jkt) => {
    credential = mint(jkt);
    remote.state.descriptorOverrides = { serverVersion: credential };
    return credential;
  };
  const f = await fixture(t, [remote]);
  const { client, stderr } = await f.client();
  await login(client, f.control);
  const result = await call(client, "register_connect_environment", { environmentId: "remote" });
  failure(result, "upstream_incompatible");
  assert.equal(JSON.stringify(result).includes(credential), false);
  assert.equal(stderr().includes(credential), false);
  assert.deepEqual(success(await call(client, "list_environments")).environments, []);
});

test("keeps environment sessions usable after OAuth expiry and keeps equal project/thread identifiers isolated", async (t) => {
  const alpha = await startConnectEnvironment("alpha", { label: "Same label" });
  const beta = await startConnectEnvironment("beta", { label: "Same label" });
  const f = await fixture(t, [alpha, beta], { expiresIn: 1, refresh: false });
  const { client } = await f.client();
  await login(client, f.control);
  for (const environmentId of ["alpha", "beta"]) success(await call(client, "register_connect_environment", { environmentId }));
  const snapshot = (text) => ({ id: "same-thread", projectId: "project", title: text, messages: [] });
  alpha.threads.set("same-thread", snapshot("Alpha thread"));
  beta.threads.set("same-thread", snapshot("Beta thread"));
  await new Promise((resolve) => setTimeout(resolve, 1050));
  failure(await call(client, "list_connect_environments"), "connect_auth_expired");
  const relayCount = f.control.relayRequests.length;
  assert.equal(success(await call(client, "get_thread", { environmentId: "alpha", threadId: "same-thread" })).thread.title, "Alpha thread");
  assert.equal(success(await call(client, "get_thread", { environmentId: "beta", threadId: "same-thread" })).thread.title, "Beta thread");
  success(await call(client, "continue_turn", { environmentId: "beta", threadId: "same-thread", prompt: "beta only" }));
  assert.equal(alpha.commands.length, 0);
  assert.equal(beta.commands.length, 1);
  assert.equal(f.control.relayRequests.length, relayCount);
  assert.equal(f.control.clerkRequests.length, 1);
  assert.deepEqual(success(await call(client, "list_environments")).environments.map((entry) => entry.id), ["alpha", "beta"]);
});

test("Connect mutations retain partial/unknown identifiers and never switch to another access path after preflight", async (t) => {
  for (const [name, dispatch, outcome, count] of [
    ["lost create", () => ({ drop: true }), "unknown", 1],
    ["invalid create acknowledgement", () => ({ body: {} }), "unknown", 1],
    ["rejected first turn", (_command, n) => n === 2 ? { status: 403, body: { secret: "dispatch-secret" } } : undefined, "partial", 2],
    ["lost first turn", (_command, n) => n === 2 ? { drop: true } : undefined, "unknown", 2],
  ]) {
    await t.test(name, async (t) => {
      const remote = await startConnectEnvironment("remote");
      const direct = await startConnectEnvironment("remote");
      t.after(() => direct.close());
      const f = await fixture(t, [remote]);
      const { client } = await f.client();
      success(await call(client, "add_environment", { endpoint: direct.baseUrl, grant: "direct-grant" }));
      await login(client, f.control);
      success(await call(client, "attach_connect_environment", { environmentId: "remote", targetEnvironmentId: "remote" }));
      remote.state.dispatch = dispatch;
      const result = await call(client, "start_turn", { environmentId: "remote", projectId: "project", prompt: "do not replay" });
      const start = success(result).start;
      assert.equal(start.outcome, outcome);
      assert.ok(start.threadId);
      assert.ok(start.createCommandId);
      if (count === 2) {
        assert.ok(start.turnCommandId);
        assert.equal(start.createSequence, 1);
        assert.equal(success(await call(client, "get_thread", { environmentId: "remote", threadId: start.threadId })).thread.id, start.threadId);
      }
      assert.equal(JSON.stringify(result).includes("dispatch-secret"), false);
      assert.equal(remote.commands.length, count);
      assert.equal(direct.commands.length, 0);
    });
  }
});

test("Connect continuation respects blocked states and never replays a lost or malformed acknowledgement", async (t) => {
  const remote = await startConnectEnvironment("remote");
  const direct = await startConnectEnvironment("remote");
  t.after(() => direct.close());
  const f = await fixture(t, [remote]);
  const { client } = await f.client();
  success(await call(client, "add_environment", { endpoint: direct.baseUrl, grant: "direct-grant" }));
  await login(client, f.control);
  success(await call(client, "attach_connect_environment", { environmentId: "remote", targetEnvironmentId: "remote" }));
  const start = success(await call(client, "start_turn", { environmentId: "remote", projectId: "project", prompt: "first" })).start;
  for (const [kind, code] of [["approval.requested", "approval_required"], ["user-input.requested", "input_required"]]) {
    remote.state.activities = [{ id: kind, tone: "info", kind, summary: kind, turnId: null,
      createdAt: new Date().toISOString(), payload: { requestId: "request" } }];
    failure(await call(client, "continue_turn", { environmentId: "remote", threadId: start.threadId, prompt: "blocked" }), code);
    assert.equal(remote.commands.length, 2);
  }
  remote.state.activities = [];
  for (const dispatch of [() => ({ drop: true }), () => ({ body: {} })]) {
    remote.state.dispatch = dispatch;
    const before = remote.commands.length;
    const continuation = success(await call(client, "continue_turn", { environmentId: "remote", threadId: start.threadId, prompt: "once" })).continuation;
    assert.equal(continuation.outcome, "unknown");
    assert.equal(continuation.threadId, start.threadId);
    assert.ok(continuation.messageId);
    assert.ok(continuation.turnCommandId);
    assert.equal(remote.commands.length, before + 1);
    assert.equal(direct.commands.length, 0);
  }
});

test("rejects malformed, expired, insecure, and unsupported Connect destinations before contacting the environment", async (t) => {
  const remote = await startConnectEnvironment("remote");
  const f = await fixture(t, [remote]);
  const { client } = await f.client();
  await login(client, f.control);
  const endpoint = { httpBaseUrl: remote.baseUrl, wsBaseUrl: remote.baseUrl.replace(/^http/, "ws"), providerKind: "cloudflare_tunnel" };
  for (const connectOverrides of [
    { credential: "" }, { credential: "unsafe credential" }, { expiresAt: "invalid" },
    { expiresAt: new Date(0).toISOString() }, { endpoint: { ...endpoint, providerKind: "manual" } },
    { endpoint: { ...endpoint, httpBaseUrl: `${remote.baseUrl}/arbitrary-path` } },
    { endpoint: { ...endpoint, httpBaseUrl: `${remote.baseUrl}/?secret=credential` } },
    { endpoint: { ...endpoint, httpBaseUrl: "http://remote.example" } },
    { endpoint: { ...endpoint, wsBaseUrl: "invalid" } },
  ]) {
    f.control.state.connectOverrides = connectOverrides;
    failure(await call(client, "register_connect_environment", { environmentId: "remote" }), "upstream_incompatible");
    assert.deepEqual(success(await call(client, "list_environments")).environments, []);
    assert.equal(remote.requests.length, 0);
  }
  f.control.state.connectOverrides = { environmentId: "wrong-identity" };
  failure(await call(client, "register_connect_environment", { environmentId: "remote" }), "connect_identity_mismatch");
  assert.equal(remote.requests.length, 0);
  f.control.state.connectOverrides = undefined;
  remote.ready = false;
  failure(await call(client, "register_connect_environment", { environmentId: "remote" }), "connect_permission_denied");
});

test("rejects malformed environment exchanges, insufficient scopes, and unauthenticated or expired sessions atomically", async (t) => {
  const remote = await startConnectEnvironment("remote");
  const direct = await startConnectEnvironment("direct");
  const f = await fixture(t, [remote, direct]);
  const { client, stderr } = await f.client();
  success(await call(client, "add_environment", { endpoint: direct.baseUrl, grant: "direct-grant" }));
  const before = success(await call(client, "list_environments"));
  await login(client, f.control);
  const cases = [
    ["tokenOverrides", { access_token: "" }, "upstream_incompatible"],
    ["tokenOverrides", { access_token: "invalid token" }, "upstream_incompatible"],
    ["tokenOverrides", { issued_token_type: "wrong" }, "upstream_incompatible"],
    ["tokenOverrides", { token_type: "Bearer" }, "upstream_incompatible"],
    ["tokenOverrides", { expires_in: 1e300 }, "upstream_incompatible"],
    ["tokenOverrides", { expires_in: 3601 }, "upstream_incompatible"],
    ["tokenOverrides", { expires_in: 0.5 }, "upstream_incompatible"],
    ["tokenOverrides", { scope: "orchestration:read" }, "permission_denied"],
    ["tokenOverrides", { scope: "orchestration:read orchestration:operate access:write" }, "permission_denied"],
    ["tokenOverrides", { scope: "orchestration:read\torchestration:operate" }, "upstream_incompatible"],
    ["sessionOverrides", { authenticated: false }, "pairing_rejected"],
    ["sessionOverrides", { sessionMethod: "bearer-access-token" }, "upstream_incompatible"],
    ["sessionOverrides", { scopes: ["orchestration:read"] }, "upstream_incompatible"],
    ["sessionOverrides", { scopes: ["orchestration:read", "orchestration:operate", "access:write"] }, "upstream_incompatible"],
    ["sessionOverrides", { expiresAt: "invalid" }, "upstream_incompatible"],
    ["sessionOverrides", { expiresAt: new Date(0).toISOString() }, "session_expired"],
  ];
  for (const [field, value, code] of cases) {
    remote.state.tokenOverrides = undefined;
    remote.state.sessionOverrides = undefined;
    remote.state[field] = value;
    failure(await call(client, "register_connect_environment", { environmentId: "remote" }), code);
    assert.deepEqual(success(await call(client, "list_environments")), before);
  }
  remote.state.sessionOverrides = undefined;
  remote.state.rejectGrant = true;
  const rejected = await call(client, "register_connect_environment", { environmentId: "remote" });
  failure(rejected, "pairing_rejected");
  assert.equal(JSON.stringify(rejected).includes("bootstrap-"), false);
  assert.deepEqual(success(await call(client, "list_environments")), before);
  assert.equal(stderr(), "");
});

test("uses retained direct access when an unexpired preferred Connect path is unreachable or revoked, without replaying dispatch", async (t) => {
  for (const fault of ["unreachable", "revoked", "server outage"]) {
    await t.test(fault, async (t) => {
      const direct = await startConnectEnvironment("remote", { label: "Direct" });
      const remote = await startConnectEnvironment("remote", { label: "Connect" });
      const f = await fixture(t, [remote]);
      t.after(() => direct.close());
      const { client } = await f.client();
      success(await call(client, "add_environment", { endpoint: direct.baseUrl, grant: "direct-grant" }));
      await login(client, f.control);
      success(await call(client, "attach_connect_environment", { environmentId: "remote", targetEnvironmentId: "remote" }));
      if (fault === "unreachable") remote.state.readDrop = true;
      else if (fault === "revoked") remote.sessions.clear();
      else remote.state.readStatus = 503;
      success(await call(client, "sign_out_connect"));
      assert.deepEqual(success(await call(client, "list_projects", { environmentId: "remote" })).projects, [{ id: "project", name: "Direct" }]);
      const start = success(await call(client, "start_turn", { environmentId: "remote", projectId: "project", prompt: "start" })).start;
      assert.equal(start.outcome, "acknowledged");
      assert.equal(success(await call(client, "get_thread", { environmentId: "remote", threadId: start.threadId })).thread.status, "completed");
      const continuation = success(await call(client, "continue_turn", { environmentId: "remote", threadId: start.threadId, prompt: "continue" })).continuation;
      assert.equal(continuation.outcome, "acknowledged");
      direct.state.dispatch = () => ({ drop: true });
      const unknown = success(await call(client, "continue_turn", { environmentId: "remote", threadId: start.threadId, prompt: "do not replay" })).continuation;
      assert.equal(unknown.outcome, "unknown");
      assert.equal(direct.commands.length, 4);
      assert.equal(remote.commands.length, 0);
    });
  }
});

test("rejects malformed relay exchanges and reports rejected JWT/proof compatibility rather than expired OAuth login", async (t) => {
  const remote = await startConnectEnvironment("remote");
  const f = await fixture(t, [remote]);
  const { client } = await f.client();
  await login(client, f.control);
  const cases = [
    { access_token: "" }, { access_token: "invalid token" }, { issued_token_type: "wrong" },
    { token_type: "Bearer" }, { expires_in: 0 }, { expires_in: 1801 }, { expires_in: 0.5 },
    { scope: "" }, { scope: "environment:connect environment:status" }, { scope: "environment:connect  " },
  ];
  for (const relayOverrides of cases) {
    f.control.state.relayOverrides = relayOverrides;
    failure(await call(client, "register_connect_environment", { environmentId: "remote" }), "upstream_incompatible");
    assert.deepEqual(success(await call(client, "list_environments")).environments, []);
  }
  f.control.state.relayOverrides = undefined;
  f.control.state.relayStatus = 401;
  const rejected = await call(client, "register_connect_environment", { environmentId: "remote" });
  failure(rejected, "upstream_incompatible");
  assert.equal(JSON.stringify(rejected).includes(f.control.state.accessToken), false);
  assert.equal(success(await call(client, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
  assert.equal(remote.requests.length, 0);
});

test("checks descriptor identity before redeeming the bootstrap and preserves unrelated registrations", async (t) => {
  const remote = await startConnectEnvironment("remote", { descriptorId: "impostor" });
  const direct = await startConnectEnvironment("direct", { label: "remote" });
  const f = await fixture(t, [remote, direct]);
  const { client } = await f.client();
  success(await call(client, "add_environment", { endpoint: direct.baseUrl, grant: "direct-grant" }));
  const before = success(await call(client, "list_environments"));
  await login(client, f.control);
  failure(await call(client, "register_connect_environment", { environmentId: "remote" }), "connect_identity_mismatch");
  assert.equal(remote.requests.some((request) => request.path === "/oauth/token"), false);
  assert.deepEqual(success(await call(client, "list_environments")), before);
  assert.deepEqual(success(await call(client, "list_projects", { environmentId: "direct" })).projects, [{ id: "project", name: "remote" }]);
});

test("persists the endpoint actually paired when discovery has an older address", async (t) => {
  const discovery = await startConnectEnvironment("remote");
  const paired = await startConnectEnvironment("remote", { label: "Paired address" });
  t.after(() => paired.close());
  discovery.connectTarget = paired;
  const f = await fixture(t, [discovery]);
  const { client } = await f.client();
  await login(client, f.control);
  const registration = success(await call(client, "register_connect_environment", { environmentId: "remote" })).environment;
  assert.equal(registration.endpoint, `${paired.baseUrl}/`);
  assert.deepEqual(success(await call(client, "list_projects", { environmentId: "remote" })).projects, [{ id: "project", name: "Paired address" }]);
  assert.equal(discovery.requests.length, 0);
  await client.close();
  const restarted = await f.client();
  assert.deepEqual(success(await call(restarted.client, "list_projects", { environmentId: "remote" })).projects, [{ id: "project", name: "Paired address" }]);
});

test("registers only the selected ready remote and runs project/start/read/continue/read across restart and signout", async (t) => {
  const remote = await startConnectEnvironment("remote");
  const other = await startConnectEnvironment("other", { label: "remote" });
  const f = await fixture(t, [remote, other]);
  const first = await f.client();
  await login(first.client, f.control);
  assert.equal(success(await call(first.client, "list_connect_environments")).environments.length, 2);
  assert.deepEqual(success(await call(first.client, "list_environments")).environments, []);
  failure(await call(first.client, "list_projects", { environmentId: "other" }), "environment_not_found");
  const registration = success(await call(first.client, "register_connect_environment", { environmentId: "remote" })).environment;
  assert.equal(registration.id, "remote");
  assert.equal(registration.source, "connect");
  assert.deepEqual(registration.scopes, ["orchestration:read", "orchestration:operate"]);
  const savedPath = path.join(f.directory, "environments.json");
  const savedState = await readFile(savedPath, "utf8");
  assert.equal(savedState.includes("bootstrap-"), false);
  assert.equal(savedState.includes(f.control.state.accessToken), false);
  assert.equal((await stat(savedPath)).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.deepEqual(success(await call(first.client, "list_projects", { environmentId: "remote" })).projects, [{ id: "project", name: "remote" }]);
  const start = success(await call(first.client, "start_turn", { environmentId: "remote", projectId: "project", prompt: "first" })).start;
  assert.equal(start.outcome, "acknowledged");
  assert.equal("turnId" in start, false);
  const read = success(await call(first.client, "get_thread", { environmentId: "remote", threadId: start.threadId, turnLimit: 1, beforeCursor: "cursor" })).thread;
  assert.equal(read.status, "completed");
  assert.equal(read.history.turnLimit, 1);
  assert.equal(read.messages.at(-1).text, "result 1");
  await first.client.close();
  const restarted = await f.client();
  assert.deepEqual(success(await call(restarted.client, "list_environments")).environments, [registration]);
  f.control.state.outage = true;
  failure(await call(restarted.client, "list_connect_environments"), "connect_unavailable");
  const continuation = success(await call(restarted.client, "continue_turn", { environmentId: "remote", threadId: start.threadId, prompt: "second" })).continuation;
  assert.equal(continuation.outcome, "acknowledged");
  assert.equal(continuation.threadId, start.threadId);
  success(await call(restarted.client, "sign_out_connect"));
  failure(await call(restarted.client, "list_connect_environments"), "connect_auth_expired");
  const final = success(await call(restarted.client, "get_thread", { environmentId: "remote", threadId: start.threadId })).thread;
  assert.equal(final.status, "completed");
  assert.equal(final.messages.at(-1).text, "result 2");
  assert.deepEqual(remote.commands.map((command) => command.type), ["thread.create", "thread.turn.start", "thread.turn.start"]);
  assert.equal(other.requests.length, 0);
  assert.equal(first.stderr() + restarted.stderr(), "");
});
