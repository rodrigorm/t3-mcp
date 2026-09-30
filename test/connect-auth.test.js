import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { watch } from "node:fs";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture, login, call, success, failure, operatorPost, operatorLogin, relaySubjectJwt, startConnectEnvironment } from "./support/connect-http.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function gate() {
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await released; } };
}
async function start(client) {
  const auth = success(await call(client, "connect_authenticate")).authentication;
  assert.equal(auth.status, "pending");
  const url = new URL(auth.authorizationUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/login");
  assert.equal(url.search, "");
  assert.match(url.hash, /^#[A-Za-z0-9_-]{43}$/);
  return auth.authorizationUrl;
}
const status = async (client) => success(await call(client, "connect_authenticate", { action: "status" })).authentication;
async function expire(f) {
  const file = path.join(f.directory, "connect.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.auth.expiresAt = new Date(0).toISOString();
  await writeFile(file, JSON.stringify(saved));
}

test("the operator UI uses a fragment capability, no-store and restrictive CSP", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  const url = await start(client);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'.*frame-ancestors 'none'/);
  const html = await response.text();
  assert.match(html, /autocomplete="username"/);
  assert.match(html, /history.replaceState/);
  assert.equal(html.includes(new URL(url).hash.slice(1)), false);
  assert.equal(f.control.clerkRequests.length, 0);
});

test("local POST rejects foreign Origin/Host, missing or duplicate capability, duplicate fields, queries and oversized bodies", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  const url = await start(client);
  for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }]) {
    assert.equal((await operatorPost(url, "identify", { identifier: "operator@example.test" }, headers)).status, 403);
  }
  const parsed = new URL(url);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest(`${parsed.origin}/login`, { headers: { host: "evil.example" } }, (response) => {
      response.resume(); resolve(response.statusCode);
    });
    request.on("error", reject); request.end();
  });
  assert.equal(wrongHost, 403);
  for (const body of ["action=identify", `capability=wrong&action=identify`,
    `capability=${parsed.hash.slice(1)}&capability=${parsed.hash.slice(1)}`,
    `capability=${parsed.hash.slice(1)}&action=identify&action=verify`]) {
    const response = await fetch(`${parsed.origin}/login`, { method: "POST", headers: { origin: parsed.origin,
      "content-type": "application/x-www-form-urlencoded" }, body });
    assert.ok([400, 403].includes(response.status));
  }
  assert.equal((await fetch(`${parsed.origin}/login?code=secret`)).status, 403);
  assert.equal((await operatorPost(url, "identify", { identifier: "a".repeat(9000) })).status, 413);
  assert.equal(f.control.clerkRequests.length, 0);
  await operatorLogin(url);
  assert.equal((await status(client)).status, "authenticated");
});

test("MCP accepts only lifecycle actions, never identifier/password/code/token input", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  for (const field of ["identifier", "password", "code", "nativeClientToken", "jwt"]) {
    const result = await call(client, "connect_authenticate", { [field]: "private-operator-input" });
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes("private-operator-input"), false);
  }
  assert.equal(f.control.clerkRequests.length, 0);
});

test("password is attempted only when the account offers it", async (t) => {
  const f = await fixture(t, [], { firstFactors: [{ strategy: "password" }] });
  const { client, stderr } = await f.client();
  const url = await start(client);
  const identify = await operatorPost(url, "identify", { identifier: "operator@example.test" });
  assert.equal((await identify.json()).selected, "password");
  assert.equal((await operatorPost(url, "verify", { password: "operator-password" })).status, 200);
  assert.equal((await status(client)).status, "authenticated");
  assert.equal(f.control.clerkRequests.filter((r) => r.path.endsWith("/prepare_first_factor")).length, 0);
  assert.equal(JSON.stringify(await status(client)).includes("operator-password"), false);
  assert.equal(stderr(), "");
  assert.equal((await readFile(path.join(f.directory, "connect.json"), "utf8")).includes("operator-password"), false);
});

test("a rejected OTP still rotates/stages the native credential and retry uses it without reflecting error secrets", async (t) => {
  const f = await fixture(t, [], { rejectVerify: true });
  const { client, stderr } = await f.client();
  const url = await start(client);
  await operatorPost(url, "identify", { identifier: "operator@example.test" });
  const rejected = await operatorPost(url, "verify", { code: "invalid-operator-code" });
  assert.equal(rejected.status, 400);
  const message = await rejected.text();
  assert.equal(message.includes("native-client-secret"), false);
  assert.equal(message.includes("operator-password"), false);
  const staged = JSON.parse(await readFile(path.join(f.directory, "connect.json"), "utf8"));
  assert.equal(staged.pendingNative.token, f.control.state.nativeClientToken);
  assert.equal((await status(client)).status, "pending");
  f.control.state.rejectVerify = false;
  assert.equal((await operatorPost(url, "verify", { code: "123456" })).status, 200);
  assert.equal((await status(client)).status, "authenticated");
  assert.equal(stderr(), "");
});

for (const [signInStatus, factor] of [
  ["needs_second_factor", { strategy: "totp" }],
  ["needs_second_factor", { strategy: "backup_code" }],
  ["needs_second_factor", { strategy: "phone_code", phone_number_id: "phone_owned" }],
  ["needs_client_trust", { strategy: "email_code", email_address_id: "email_owned" }],
]) {
  test(`${signInStatus} completes the offered ${factor.strategy} before a session/template is accepted`, async (t) => {
    const f = await fixture(t, [], { afterFirstFactor: signInStatus, secondFactors: [factor] });
    const { client } = await f.client();
    const url = await start(client);
    await operatorPost(url, "identify", { identifier: "operator@example.test" });
    const first = await operatorPost(url, "verify", { code: "123456" });
    const view = await first.json();
    assert.equal(view.second, true);
    assert.equal(view.selected, factor.strategy);
    assert.equal((await status(client)).status, "pending");
    assert.equal(f.control.clerkRequests.some((r) => r.path.includes("/tokens/")), false);
    assert.equal((await operatorPost(url, "verify", { code: "654321" })).status, 200);
    assert.equal((await status(client)).status, "authenticated");
    const request = f.control.clerkRequests.find((r) => r.path.endsWith("/attempt_second_factor"));
    assert.equal(new URLSearchParams(request.body).get("strategy"), factor.strategy);
    if (["email_code", "phone_code"].includes(factor.strategy)) {
      const prepare = f.control.clerkRequests.find((r) => r.path.endsWith("/prepare_second_factor"));
      const form = new URLSearchParams(prepare.body);
      const field = factor.strategy === "email_code" ? "email_address_id" : "phone_number_id";
      assert.equal(form.get(field), factor[field]);
    }
  });
}

for (const [name, options, message] of [
  ["social-only", { firstFactors: [{ strategy: "oauth_google" }] }, /Social\/SSO.*native callback/],
  ["passkey-only", { firstFactors: [{ strategy: "passkey" }] }, /passkeys.*OS bridge/],
  ["password-reset", { afterFirstFactor: "needs_new_password" }, /password reset/],
  ["unsupported second factor", { afterFirstFactor: "needs_second_factor", secondFactors: [{ strategy: "email_link" }] }, /second factor.*unavailable/],
  ["Protect challenge", { protectCheck: { status: "needs_verification", token: "never-reflect-protect-token" } }, /Protect challenge/],
  ["pending session tasks", { tasks: [{ key: "choose-organization" }] }, /pending session tasks/],
]) {
  test(`${name} reports truthful recovery and does not mint a template or bypass verification`, async (t) => {
    const f = await fixture(t, [], options);
    const { client } = await f.client();
    const url = await start(client);
    let response = await operatorPost(url, "identify", { identifier: "operator@example.test" });
    if (response.status === 200) response = await operatorPost(url, "verify", { code: "123456" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, message);
    const state = await status(client);
    assert.notEqual(state.status, "authenticated");
    assert.equal(JSON.stringify(state).includes("never-reflect-protect-token"), false);
    assert.equal(f.control.clerkRequests.some((r) => r.path.includes("/tokens/")), false);
  });
}

test("HTTP 200 complete attempt must prove a single active client-owned session and a real account", async (t) => {
  for (const clientResponse of [
    { id: "client_wrong", sessions: [] },
    { id: "client_wrong", sessions: [{ id: "foreign", status: "active", user: { id: "connect-account-a" } }] },
    { id: "client_wrong", sessions: [{ id: "sess_owned" }, { id: "other" }] },
  ]) {
    const f = await fixture(t, [], { clientResponse });
    const { client } = await f.client();
    const url = await start(client);
    await operatorPost(url, "identify", { identifier: "operator@example.test" });
    assert.equal((await operatorPost(url, "verify", { code: "123456" })).status, 400);
    assert.equal((await status(client)).error.code, "connect_account_conflict");
    assert.equal(f.control.relayRequests.length, 0);
  }
});

test("template response shape, audience, subject and expiry fail safely without accepting arbitrary JWT handoff", async (t) => {
  for (const templateResponse of [null, [], {}, { jwt: "opaque-secret" }, { jwt: relaySubjectJwt("wrong-audience") },
    { jwt: relaySubjectJwt("t3-code-relay", "wrong-account") }, { jwt: relaySubjectJwt("t3-code-relay", "connect-account-a", -1) }]) {
    const f = await fixture(t, [], { templateResponse });
    const { client, stderr } = await f.client();
    const url = await start(client);
    await operatorPost(url, "identify", { identifier: "operator@example.test" });
    assert.equal((await operatorPost(url, "verify", { code: "123456" })).status, 400);
    assert.equal((await status(client)).error.code, "upstream_incompatible");
    assert.equal(f.control.relayRequests.length, 0);
    assert.equal(stderr(), "");
  }
});

test("a template with invalid signature cannot authenticate merely because its local claims look right", async (t) => {
  const valid = relaySubjectJwt();
  const f = await fixture(t, [], { accessToken: valid.slice(0, -10) + "invalidsig" });
  const { client } = await f.client();
  const url = await start(client);
  await operatorPost(url, "identify", { identifier: "operator@example.test" });
  assert.equal((await operatorPost(url, "verify", { code: "123456" })).status, 400);
  assert.equal((await status(client)).status, "failed");
});

test("short template JWTs renew after their actual exp without password/code or sign-in recreation", async (t) => {
  const f = await fixture(t, [], { templateLifetime: 2 });
  const { client } = await f.client();
  await login(client, f.control);
  await pause(2100);
  success(await call(client, "list_connect_environments"));
  assert.equal(f.control.clerkRequests.filter((r) => r.path === "/v1/client/sign_ins").length, 1);
  assert.equal(f.control.clerkRequests.filter((r) => r.path.endsWith("/attempt_first_factor")).length, 1);
  assert.ok(f.control.clerkRequests.filter((r) => r.path.endsWith("/tokens/t3-relay")).length >= 2);
});

test("renewal rejects a changed account and preserves its original pin during browser recovery", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  await login(client, f.control);
  await expire(f);
  f.control.state.accountId = "connect-account-b";
  failure(await call(client, "list_connect_environments"), "connect_account_conflict");
  assert.equal((await status(client)).error.code, "connect_account_conflict");
  const saved = JSON.parse(await readFile(path.join(f.directory, "connect.json"), "utf8"));
  assert.equal(saved.auth.accountId, "connect-account-a");
});

test("browser recovery cannot switch a retained expired account until explicit sign-out", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  await login(client, f.control);
  await expire(f);
  f.control.state.clerkStatus = 401;
  failure(await call(client, "list_connect_environments"), "connect_auth_expired");
  f.control.state.clerkStatus = undefined;
  f.control.state.accountId = "connect-account-b";
  const url = await start(client);
  await operatorPost(url, "identify", { identifier: "operator@example.test" });
  assert.equal((await operatorPost(url, "verify", { code: "123456" })).status, 400);
  assert.equal((await status(client)).error.code, "connect_account_conflict");
  await call(client, "sign_out_connect");
  f.control.state.accessToken = relaySubjectJwt("t3-code-relay", "connect-account-b");
  await login(client, f.control);
  assert.equal((await status(client)).status, "authenticated");
});

test("revoked or expired owned sessions require reauthentication rather than an OAuth refresh", async (t) => {
  for (const options of [{ sessionStatus: "revoked" }, { sessionExpiresAt: 1 }, { clerkStatus: 401 }]) {
    const f = await fixture(t);
    const { client } = await f.client();
    await login(client, f.control);
    await expire(f);
    Object.assign(f.control.state, options);
    failure(await call(client, "list_connect_environments"), "connect_auth_expired");
    assert.equal((await status(client)).error.code, "connect_auth_expired");
    assert.equal(f.control.clerkRequests.some((r) => r.path === "/oauth/token"), false);
  }
});

test("sign-out wins over a held renewal without waiting for it or restoring credentials on restart", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  await login(client, f.control);
  await expire(f);
  const g = gate(); t.after(g.release);
  f.control.state.beforeClerk = async (pathname) => { if (pathname === "/v1/client") await g.wait(); };
  const discovery = call(client, "list_connect_environments");
  await g.entered;
  const signedOut = await Promise.race([call(client, "sign_out_connect"), pause(1500).then(() => null)]);
  assert.notEqual(signedOut, null);
  g.release();
  failure(await discovery, "connect_auth_cancelled");
  await client.close();
  const restarted = await f.client();
  assert.equal((await status(restarted.client)).status, "signed_out");
});

test("cancellation rejects a late local POST without blocking or corrupting a new login", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  const url = await start(client);
  const g = gate(); t.after(g.release);
  f.control.state.beforeClerk = async (pathname) => { if (pathname === "/v1/client/sign_ins") await g.wait(); };
  const held = operatorPost(url, "identify", { identifier: "operator@example.test" });
  await g.entered;
  await call(client, "connect_authenticate", { action: "cancel" });
  const next = await start(client);
  f.control.state.beforeClerk = undefined;
  g.release();
  assert.equal((await held).status, 400);
  assert.equal((await status(client)).authorizationUrl, next);
  await operatorLogin(next);
  assert.equal((await status(client)).status, "authenticated");
});

test("the local operator cancel action can interrupt an in-flight form submission", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  const url = await start(client);
  const g = gate(); t.after(g.release);
  f.control.state.beforeClerk = async (pathname) => { if (pathname === "/v1/client/sign_ins") await g.wait(); };
  const held = operatorPost(url, "identify", { identifier: "operator@example.test" });
  await g.entered;
  const cancelled = await operatorPost(url, "cancel");
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).step, "cancelled");
  g.release();
  assert.equal((await held).status, 400);
  assert.equal((await status(client)).status, "cancelled");
  await client.close();
  const restarted = await f.client();
  assert.equal((await status(restarted.client)).status, "signed_out");
});

test("a held stale discovery 401 cannot retire a newer rotated native login", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  await login(client, f.control);
  const g = gate(); t.after(g.release);
  let held = false;
  f.control.state.beforeDiscovery = async () => { if (!held) { held = true; await g.wait(); } };
  const stale = call(client, "list_connect_environments");
  await g.entered;
  await expire(f);
  success(await call(client, "list_connect_environments"));
  f.control.state.discoveryStatus = 401;
  g.release();
  failure(await stale, "connect_auth_expired");
  f.control.state.discoveryStatus = 200;
  assert.equal((await status(client)).status, "authenticated");
  success(await call(client, "list_connect_environments"));
});

test("discovery rejects native/template/DPoP secret reflection and malformed metadata", async (t) => {
  const remote = await startConnectEnvironment("remote");
  const f = await fixture(t, [remote]);
  const { client, stderr } = await f.client();
  await login(client, f.control);
  const saved = JSON.parse(await readFile(path.join(f.directory, "connect.json"), "utf8"));
  const record = { environmentId: "remote", label: "Remote", linkedAt: "2026-09-20T00:00:00Z",
    endpoint: { httpBaseUrl: remote.baseUrl, wsBaseUrl: remote.baseUrl.replace("http", "ws"), providerKind: "cloudflare_tunnel" } };
  for (const secret of [saved.auth.nativeClientToken, saved.auth.accessToken, saved.auth.dpopPrivateJwk.d]) {
    for (const field of ["label", "environmentId", "linkedAt"]) {
      f.control.state.environments = [{ ...record, [field]: secret }];
      const result = await call(client, "list_connect_environments");
      failure(result, "upstream_incompatible");
      assert.equal(JSON.stringify(result).includes(secret), false);
    }
    f.control.state.environments = [{ ...record, endpoint: { ...record.endpoint, wsBaseUrl: `wss://${secret}.example` } }];
    failure(await call(client, "list_connect_environments"), "upstream_incompatible");
  }
  for (const overrides of [{ label: "" }, { linkedAt: "" }, { endpoint: null }]) {
    f.control.state.environments = [{ ...record, ...overrides }];
    failure(await call(client, "list_connect_environments"), "upstream_incompatible");
  }
  assert.deepEqual(success(await call(client, "list_environments")).environments, []);
  assert.equal(stderr(), "");
});

test("native config association prevents sending persisted credentials to a changed Frontend API or relay", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  await login(client, f.control);
  await client.close();
  const count = f.control.clerkRequests.length;
  f.control.env.T3_MCP_CONNECT_FRONTEND_API_URL = "http://127.0.0.1:1";
  const restarted = await f.client();
  failure(await call(restarted.client, "list_connect_environments"), "connect_auth_expired");
  assert.equal(f.control.clerkRequests.length, count);
});

test("local sign-out succeeds with broken current config and never forwards the owned native credential", async (t) => {
  const f = await fixture(t);
  const first = await f.client();
  await login(first.client, f.control);
  await first.client.close();
  f.control.env.T3_MCP_CONNECT_CALLBACK_PORT = "invalid-port";
  const restarted = await f.client();
  const count = f.control.clerkRequests.length;
  assert.equal(success(await call(restarted.client, "sign_out_connect")).signedOut, true);
  assert.equal(f.control.clerkRequests.length, count);
  assert.equal((await status(restarted.client)).status, "signed_out");
});

test("obsolete OAuth state migrates to native reauthentication while preserving environment sessions and proof keys", async (t) => {
  const remote = await startConnectEnvironment("remote");
  const f = await fixture(t, [remote]);
  const { client } = await f.client();
  await login(client, f.control);
  success(await call(client, "register_connect_environment", { environmentId: "remote" }));
  const envFile = path.join(f.directory, "environments.json");
  const before = await readFile(envFile, "utf8");
  const file = path.join(f.directory, "connect.json");
  const auth = JSON.parse(await readFile(file, "utf8")).auth;
  await writeFile(file, JSON.stringify({ version: 1, auth: { accessToken: "obsolete-oauth", refreshToken: "obsolete-refresh",
    expiresAt: auth.expiresAt, accountId: auth.accountId, dpopPrivateJwk: auth.dpopPrivateJwk } }));
  assert.equal((await status(client)).error.code, "connect_auth_expired");
  const migrated = await readFile(file, "utf8");
  assert.equal(JSON.parse(migrated).version, 2);
  assert.equal(migrated.includes("obsolete-"), false);
  assert.equal(await readFile(envFile, "utf8"), before);
  success(await call(client, "list_projects", { environmentId: "remote" }));
  await login(client, f.control);
  assert.equal(await readFile(envFile, "utf8"), before);
});

test("native credential storage stays private, rejects unsafe permissions and invalid expiry with safe errors", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  await login(client, f.control);
  const file = path.join(f.directory, "connect.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  const saved = await readFile(file, "utf8");
  const corrupt = JSON.parse(saved); corrupt.auth.expiresAt = "not-a-date";
  await writeFile(file, JSON.stringify(corrupt));
  failure(await call(client, "connect_authenticate", { action: "status" }), "storage_error");
  await writeFile(file, saved);
  await chmod(file, 0o644);
  const result = await call(client, "connect_authenticate", { action: "status" });
  failure(result, "storage_error");
  assert.equal(JSON.stringify(result).includes(f.directory), false);
  await chmod(file, 0o600);
  assert.equal((await status(client)).status, "authenticated");
});

test("cancelling recovery preserves retained login and sign-out independently clears only Connect ownership", async (t) => {
  const remote = await startConnectEnvironment("remote");
  const f = await fixture(t, [remote]);
  const { client } = await f.client();
  success(await call(client, "add_environment", { endpoint: remote.baseUrl, grant: "direct-grant" }));
  await login(client, f.control);
  await expire(f);
  f.control.state.clerkStatus = 401;
  const url = await start(client);
  assert.ok(url);
  await call(client, "connect_authenticate", { action: "cancel" });
  const saved = JSON.parse(await readFile(path.join(f.directory, "connect.json"), "utf8"));
  assert.equal(saved.auth.accountId, "connect-account-a");
  f.control.state.clerkStatus = undefined;
  await call(client, "sign_out_connect");
  assert.equal((await status(client)).status, "signed_out");
  success(await call(client, "list_projects", { environmentId: "remote" }));
  assert.equal(success(await call(client, "sign_out_connect")).signedOut, false);
});

for (const recovery of [false, true]) {
  test(`cancelling a real in-progress native auth write survives restart${recovery ? " and preserves the retained owned login" : ""}`, { timeout: 30_000 }, async (t) => {
    const f = await fixture(t);
    const { client } = await f.client();
    if (recovery) {
      await login(client, f.control);
      await expire(f);
      f.control.state.templateResponse = { jwt: "incompatible-template" };
    }
    const url = await start(client);
    delete f.control.state.templateResponse;
    if (recovery) {
      const file = path.join(f.directory, "connect.json");
      const saved = JSON.parse(await readFile(file, "utf8"));
      saved.auth.expiresAt = new Date(Date.now() + 3600_000).toISOString();
      await writeFile(file, JSON.stringify(saved));
    }
    await operatorPost(url, "identify", { identifier: "operator@example.test" });
    const smallToken = f.control.state.accessToken;
    // A large, genuinely signed template response makes the actual atomic save
    // observable at the existing filesystem/MCP boundary, without a private test hook.
    f.control.state.accessToken = relaySubjectJwt("t3-code-relay", "connect-account-a", 3600,
      { fixture_padding: "a".repeat(16 * 1024 * 1024) });
    const g = gate(); t.after(g.release);
    f.control.state.beforeDiscovery = g.wait;
    const verification = operatorPost(url, "verify", { code: "123456" });
    const reached = await Promise.race([g.entered.then(() => true), verification.then(async (response) => {
      const outcome = await response.json();
      assert.fail(outcome.message);
    })]);
    assert.equal(reached, true);
    let created;
    const writing = new Promise((resolve) => { created = resolve; });
    const watcher = watch(f.directory, (_event, name) => {
      if (name?.startsWith(".connect-") && name.endsWith(".tmp")) created();
    });
    t.after(() => watcher.close());
    g.release();
    await writing;
    assert.equal(success(await call(client, "connect_authenticate", { action: "cancel" })).authentication.status, "cancelled");
    assert.equal((await verification).status, 400);
    watcher.close();
    f.control.state.beforeDiscovery = undefined;
    f.control.state.accessToken = smallToken;
    await client.close();
    const restarted = await f.client();
    assert.equal((await status(restarted.client)).status, recovery ? "authenticated" : "signed_out");
    if (recovery) success(await call(restarted.client, "list_connect_environments"));
  });
}
