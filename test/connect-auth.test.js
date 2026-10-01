import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { chmod, mkdir, readFile, readlink, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture, login, call, success, failure, operatorLogin, relaySubjectJwt, startConnectEnvironment } from "./support/connect-http.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function gate() {
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await released; } };
}
const status = async (client) => success(await call(client, "connect_authenticate", { action: "status" })).authentication;
async function terminal(client) {
  const deadline = Date.now() + 20_000;
  let result;
  do { result = await status(client); if (result.status !== "pending") return result; await pause(100); } while (Date.now() < deadline);
  assert.fail("The actual browser authentication did not reach a terminal public status.");
}
async function start(client) {
  const auth = success(await call(client, "connect_authenticate")).authentication;
  assert.equal(auth.status, "pending"); assert.equal(auth.browserOpened, true);
  const url = new URL(auth.authorizationUrl);
  assert.equal(url.pathname, "/"); assert.equal(url.search + url.hash, "");
  return auth.authorizationUrl;
}
async function saved(f) { return JSON.parse(await readFile(path.join(f.directory, "connect.json"), "utf8")); }
async function expire(f) {
  const value = await saved(f); value.auth.expiresAt = new Date(0).toISOString();
  await writeFile(path.join(f.directory, "connect.json"), JSON.stringify(value));
}

test("direct service sign-in uses actual browser cookies, public SDK template options and private owned state", async (t) => {
  const f = await fixture(t);
  const { client, stderr } = await f.client();
  await login(client, f.control);
  const value = await saved(f);
  assert.equal(value.version, 3);
  assert.equal(value.auth.accountId, "connect-account-a");
  assert.match(value.auth.browserProfile, /^[a-f0-9-]{36}$/);
  assert.equal(value.auth.nativeClientToken, undefined);
  assert.equal(value.auth.refreshToken, undefined);
  assert.equal(JSON.stringify(value).includes(f.control.state.browserCookie), false);
  const token = f.control.clerkRequests.find((request) => request.path.endsWith("/tokens/t3-relay"));
  assert.match(token.headers.cookie, /__client=fixture-browser-client-/);
  assert.equal(token.headers.authorization, undefined);
  for (const secret of [f.control.state.accessToken, f.control.state.browserCookie, "operator-password"]) {
    assert.equal(JSON.stringify(await status(client)).includes(secret), false);
    assert.equal(stderr().includes(secret), false);
  }
  assert.equal((await stat(path.join(f.directory, "connect-browser-profiles", value.auth.browserProfile))).mode & 0o777, 0o700);
});

test("restart reopens the same owned profile, rotates service cookies and renews a template without another login", async (t) => {
  const f = await fixture(t);
  const first = await f.client(); await login(first.client, f.control);
  const before = await saved(f), cookie = f.control.state.browserCookie;
  const requests = f.control.clerkRequests.length;
  await first.client.close();
  const restarted = await f.client();
  assert.equal((await status(restarted.client)).status, "authenticated");
  const after = await saved(f);
  assert.equal(after.auth.browserProfile, before.auth.browserProfile);
  assert.deepEqual(after.auth.dpopPrivateJwk, before.auth.dpopPrivateJwk);
  assert.notEqual(f.control.state.browserCookie, cookie);
  const loaded = f.control.clerkRequests.slice(requests);
  assert.ok(loaded.some((request) => request.headers?.cookie?.includes(cookie)));
  assert.equal(loaded.some((request) => request.path === "/v1/sign_in" || request.path.startsWith("provider")), false);
});

test("short template expiry and concurrent renewal are handled by the service SDK without re-login or cookie replay", async (t) => {
  const f = await fixture(t, [], { templateLifetime: 2 });
  const { client } = await f.client(); await login(client, f.control);
  const before = f.control.clerkRequests.filter((request) => request.path.endsWith("/tokens/t3-relay")).length;
  await pause(2100);
  await Promise.all([call(client, "list_connect_environments"), call(client, "list_connect_environments")].map(async (result) => success(await result)));
  assert.equal(f.control.clerkRequests.filter((request) => request.path.endsWith("/tokens/t3-relay")).length, before + 1);
  assert.equal(f.control.clerkRequests.filter((request) => request.path === "/v1/sign_in").length, 1);
});

test("registration refreshes a short JWT after held discovery and before the strict relay exchange", async (t) => {
  const remote = await startConnectEnvironment("remote");
  const short = relaySubjectJwt("t3-code-relay", "connect-account-a", 10);
  const f = await fixture(t, [remote], { accessToken: short }); const { client } = await f.client(); await login(client, f.control);
  const original = (await saved(f)).auth;
  const g = gate(); t.after(g.release); let held = false;
  f.control.state.beforeDiscovery = async () => { if (!held) { held = true; await g.wait(); } };
  const registration = call(client, "register_connect_environment", { environmentId: "remote" }); await g.entered;
  // Advance only the controlled issuer/relay clock and the approved cache-expiry
  // fixture. Discovery was already authorized, but its subject is now expired.
  const claims = JSON.parse(Buffer.from(short.split(".")[1], "base64url"));
  f.control.state.subjectNow = claims.exp + 1;
  f.control.state.accessToken = relaySubjectJwt();
  await expire(f); g.release();
  success(await registration);
  const current = (await saved(f)).auth;
  assert.equal(current.accountId, original.accountId); assert.deepEqual(current.dpopPrivateJwk, original.dpopPrivateJwk);
  assert.equal(f.control.clerkRequests.filter((request) => request.path.endsWith("/tokens/t3-relay")).length, 2);
  assert.equal(f.control.clerkRequests.filter((request) => request.path === "/v1/sign_in").length, 1);
});

test("all provider/challenge choices belong to the service UI; pending tasks cannot produce a connector grant", async (t) => {
  const f = await fixture(t, [], { tasks: [{ key: "service-task" }] });
  const { client } = await f.client();
  const url = await start(client); await operatorLogin(url, "provider_mfa");
  await pause(500);
  assert.equal((await status(client)).status, "pending");
  assert.equal(f.control.clerkRequests.some((request) => request.path.includes("/tokens/")), false);
  await call(client, "connect_authenticate", { action: "cancel" });
  assert.equal((await status(client)).status, "cancelled");
});

test("provider denial is reported from the public SDK verification resource without reflecting service errors", async (t) => {
  const f = await fixture(t); const { client, stderr } = await f.client();
  const url = await start(client); await operatorLogin(url, "provider_denied");
  for (let n = 0; n < 100; n += 1) {
    if (f.control.clerkRequests.some((request) => request.path === "provider/deny")) break;
    await pause(20);
  }
  await pause(100);
  const result = await status(client);
  assert.equal(result.status, "failed"); assert.equal(result.error.code, "connect_auth_failed");
  assert.equal(JSON.stringify(result).includes("fixture-provider-secret"), false);
  assert.equal(stderr().includes("fixture-provider-secret"), false);
  assert.equal(f.control.clerkRequests.some((request) => request.path.includes("/tokens/")), false);
});

test("malformed public SDK verification states fail safely and expired verification is terminal", async (t) => {
  const f = await fixture(t); const { client } = await f.client();
  for (const resource of ["fixture-provider-secret", { firstFactorVerification: [] },
    { firstFactorVerification: { status: "denied", error: null } },
    { firstFactorVerification: { status: ["unverified"], error: null } },
    { secondFactorVerification: { status: "failed", error: { code: 42, message: "fixture-provider-secret" } } }]) {
    f.control.state.signInResource = resource;
    await start(client);
    const result = await status(client);
    assert.equal(result.status, "failed"); assert.equal(result.error.code, "upstream_incompatible");
    assert.equal(JSON.stringify(result).includes("fixture-provider-secret"), false);
  }
  f.control.state.signInResource = { secondFactorVerification: { status: "expired", error: null } };
  await start(client);
  assert.equal((await status(client)).error.code, "connect_auth_expired");
});

test("retryable SDK verification errors keep the official UI available for a successful retry", async (t) => {
  const f = await fixture(t, [], { firstVerification: { status: "failed", error: { code: "form_code_incorrect", message: "fixture-provider-secret" } } });
  const { client } = await f.client(); const url = await start(client);
  const pending = await status(client); assert.equal(pending.status, "pending");
  assert.equal(JSON.stringify(pending).includes("fixture-provider-secret"), false);
  await operatorLogin(url);
  assert.equal((await terminal(client)).status, "authenticated");
});

test("an actual provider popup completes MFA and propagates its session through the parent service SDK", async (t) => {
  const f = await fixture(t); const { client } = await f.client();
  const url = await start(client); await operatorLogin(url, "popup_mfa");
  assert.equal((await terminal(client)).status, "authenticated");
  assert.ok(f.control.clerkRequests.some((request) => request.path === "provider/verify"));
  assert.equal(f.control.clerkRequests.some((request) => request.path === "/v1/sign_in"), false);
  assert.ok(f.control.clerkRequests.filter((request) => request.path === "/v1/client").length >= 3);
});

test("a denied provider popup propagates terminal SDK verification state without a false success", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); const url = await start(client);
  await operatorLogin(url, "popup_denied");
  const result = await terminal(client);
  assert.equal(result.status, "failed"); assert.equal(result.error.code, "connect_auth_failed");
  assert.equal(JSON.stringify(result).includes("fixture-provider-secret"), false);
  assert.equal(f.control.clerkRequests.some((request) => request.path.includes("/tokens/")), false);
});

test("a service-cancelled popup closes while the parent remains pending and permits an official UI retry", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); const url = await start(client);
  await operatorLogin(url, "popup_cancel");
  for (let n = 0; n < 100; n += 1) {
    if (f.control.clerkRequests.some((request) => request.path === "provider/cancel") &&
      f.control.clerkRequests.filter((request) => request.path === "/v1/client").length >= 2) break;
    await pause(20);
  }
  assert.equal((await status(client)).status, "pending");
  await operatorLogin(url, "popup_mfa");
  assert.equal((await terminal(client)).status, "authenticated");
});

test("closing a provider popup without a success callback leaves the parent SDK free to retry", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); const url = await start(client);
  await operatorLogin(url, "popup_close");
  for (let n = 0; n < 100; n += 1) {
    if (f.control.clerkRequests.some((request) => request.path === "provider/authorize") &&
      f.control.clerkRequests.filter((request) => request.path === "/v1/client").length >= 2) break;
    await pause(20);
  }
  assert.equal((await status(client)).status, "pending");
  assert.equal(f.control.clerkRequests.some((request) => request.path === "provider/verify"), false);
  await operatorLogin(url, "popup_mfa");
  assert.equal((await terminal(client)).status, "authenticated");
});

test("connector cancellation closes the parent and a held provider popup without saving late completion", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); const url = await start(client);
  const g = gate(); t.after(g.release);
  f.control.state.beforeProvider = async (pathname) => { if (pathname === "/verify") await g.wait(); };
  await operatorLogin(url, "popup_mfa"); await g.entered;
  assert.equal((await status(client)).status, "pending");
  success(await call(client, "connect_authenticate", { action: "cancel" })); g.release();
  assert.equal((await status(client)).status, "cancelled");
  assert.deepEqual(await readdir(path.join(f.directory, "connect-browser-profiles")), []);
  await client.close(); const restarted = await f.client();
  assert.equal((await status(restarted.client)).status, "signed_out");
});

test("MCP accepts lifecycle actions, never identifiers, passwords, provider choices, cookies, codes or tokens", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  for (const field of ["identifier", "password", "code", "provider", "cookie", "jwt"]) {
    const result = await call(client, "connect_authenticate", { [field]: "private-operator-input" });
    assert.equal(result.isError, true); assert.equal(JSON.stringify(result).includes("private-operator-input"), false);
  }
  assert.equal(f.control.clerkRequests.length, 0);
});

test("browser protocol debugging cannot print private SDK results into connector diagnostics", async (t) => {
  const f = await fixture(t);
  f.control.env.DEBUG = "pw:protocol,pw:api,pw:browser";
  f.control.env.PWDEBUG = "console";
  const { client, stderr } = await f.client(); await login(client, f.control);
  assert.equal(stderr(), "");
  assert.equal(JSON.stringify(await status(client)).includes(f.control.state.browserCookie), false);
});

test("missing browser errors are actionable and sanitized, while direct environment tools remain browser-free", async (t) => {
  const remote = await startConnectEnvironment("direct");
  const f = await fixture(t, [remote]);
  f.control.env.T3_MCP_CONNECT_BROWSER_EXECUTABLE = "/missing/private/browser-executable";
  const { client } = await f.client();
  success(await call(client, "add_environment", { endpoint: remote.baseUrl, grant: "direct-grant" }));
  success(await call(client, "list_projects", { environmentId: "direct" }));
  const result = await call(client, "connect_authenticate");
  failure(result, "connect_auth_failed");
  assert.match(result.structuredContent.error.message, /T3_MCP_CONNECT_BROWSER_EXECUTABLE/);
  assert.equal(JSON.stringify(result).includes("/missing/private"), false);
  assert.equal(f.control.clerkRequests.length, 0);
});

test("a second stdio process cannot replay credentials from a profile owned by a live connector", async (t) => {
  const f = await fixture(t); const first = await f.client(); await login(first.client, f.control);
  const second = await f.client(), before = f.control.clerkRequests.length;
  failure(await call(second.client, "list_connect_environments"), "storage_error");
  assert.equal(f.control.clerkRequests.length, before);
  await first.client.close();
  assert.equal((await status(second.client)).status, "authenticated");
});

test("simultaneous MCP startup after a dead owner grants exactly one process the credential lock", async (t) => {
  const f = await fixture(t);
  const original = await f.client(); assert.equal((await status(original.client)).status, "signed_out");
  const lockFile = path.join(f.directory, ".connect-owner"), inode = (await stat(lockFile)).ino;
  const pid = original.pid(); assert.ok(pid > 0);
  process.kill(pid, "SIGKILL"); await original.client.close();
  const contenders = await Promise.all(Array.from({ length: 16 }, () => f.client()));
  const results = await Promise.all(contenders.map(({ client }) => call(client, "connect_authenticate", { action: "status" })));
  const winners = results.map((result, index) => result.isError ? -1 : index).filter((index) => index >= 0);
  assert.equal(winners.length, 1, "OS ownership must have one winner, including stale-owner startup");
  assert.equal((await stat(lockFile)).ino, inode, "The guarded lock inode must never be unlinked or replaced");
  for (const result of results.filter((result) => result.isError)) failure(result, "storage_error");
  assert.equal((await status(contenders[winners[0]].client)).status, "signed_out");
  await contenders[winners[0]].client.close();
  const successor = contenders.find((_entry, index) => index !== winners[0]);
  assert.equal((await status(successor.client)).status, "signed_out");
});

for (const options of [{ sessionStatus: "revoked" }, { sessionExpiresAt: 1 }]) {
  test(`a ${options.sessionStatus ?? "expired"} service session cannot survive restart as an authenticated cached JWT`, async (t) => {
    const f = await fixture(t); const first = await f.client(); await login(first.client, f.control);
    await first.client.close(); Object.assign(f.control.state, options);
    const restarted = await f.client();
    assert.equal((await status(restarted.client)).error.code, "connect_auth_expired");
    failure(await call(restarted.client, "list_connect_environments"), "connect_auth_expired");
  });
}

test("changed accounts are rejected during renewal and the original pin survives browser recovery", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); await login(client, f.control); await expire(f);
  f.control.state.accountId = "connect-account-b";
  f.control.state.accessToken = relaySubjectJwt("t3-code-relay", "connect-account-b");
  failure(await call(client, "list_connect_environments"), "connect_account_conflict");
  assert.equal((await saved(f)).auth.accountId, "connect-account-a");
  assert.equal((await status(client)).error.code, "connect_account_conflict");
  await call(client, "sign_out_connect"); await login(client, f.control);
  assert.equal((await saved(f)).auth.accountId, "connect-account-b");
});

test("browser recovery cannot replace a retained expired account until explicit sign-out", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); await login(client, f.control); await expire(f);
  f.control.state.sessionStatus = "revoked";
  failure(await call(client, "list_connect_environments"), "connect_auth_expired");
  const url = await start(client);
  f.control.state.sessionStatus = "active"; f.control.state.accountId = "connect-account-b";
  f.control.state.accessToken = relaySubjectJwt("t3-code-relay", "connect-account-b");
  await operatorLogin(url);
  assert.equal((await terminal(client)).error.code, "connect_account_conflict");
  assert.equal((await saved(f)).auth.accountId, "connect-account-a");
});

test("malformed templates and invalid signatures are rejected before authenticated status", async (t) => {
  const f = await fixture(t); const { client } = await f.client();
  const valid = relaySubjectJwt();
  for (const templateResponse of [null, {}, { jwt: "opaque-secret" }, { jwt: relaySubjectJwt("wrong-audience") },
    { jwt: relaySubjectJwt("t3-code-relay", "wrong-account") }, { jwt: relaySubjectJwt("t3-code-relay", "connect-account-a", -1) },
    { jwt: valid.slice(0, -10) + "invalidsig" }]) {
    f.control.state.templateResponse = templateResponse;
    const url = await start(client); await operatorLogin(url);
    const result = await terminal(client);
    assert.equal(result.status, "failed");
    assert.ok(["upstream_incompatible", "connect_auth_expired", "connect_unavailable"].includes(result.error.code));
    assert.equal(JSON.stringify(result).includes("opaque-secret"), false);
  }
});

test("cancellation closes the actual pending browser and discards only its profile, surviving restart", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); await start(client);
  const profiles = path.join(f.directory, "connect-browser-profiles");
  assert.equal((await readdir(profiles)).length, 1);
  await call(client, "connect_authenticate", { action: "cancel" });
  assert.deepEqual(await readdir(profiles), []);
  assert.equal((await status(client)).status, "cancelled");
  await client.close(); const restarted = await f.client();
  assert.equal((await status(restarted.client)).status, "signed_out");
});

test("overlapping cancel and start cannot close the newer headed login browser", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); await start(client);
  const cancelling = call(client, "connect_authenticate", { action: "cancel" });
  const starting = call(client, "connect_authenticate", { action: "start" });
  success(await cancelling);
  const next = success(await starting).authentication;
  assert.equal(next.status, "pending"); assert.equal(next.browserOpened, true);
  await operatorLogin(next.authorizationUrl);
  assert.equal((await terminal(client)).status, "authenticated");
});

test("closing the actual owned browser while pending cannot authenticate or alter an environment session", async (t) => {
  const remote = await startConnectEnvironment("direct"); const f = await fixture(t, [remote]);
  const { client } = await f.client();
  success(await call(client, "add_environment", { endpoint: remote.baseUrl, grant: "direct-grant" }));
  const before = await readFile(path.join(f.directory, "environments.json"), "utf8");
  await start(client);
  const profile = (await saved(f)).pendingProfile;
  const lock = await readlink(path.join(f.directory, "connect-browser-profiles", profile, "SingletonLock"));
  const pid = Number(lock.match(/-(\d+)$/)?.[1]);
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  process.kill(pid, "SIGTERM"); await pause(100);
  const result = await terminal(client);
  assert.equal(result.status, "failed"); assert.equal(result.error.code, "connect_auth_cancelled");
  assert.equal(await readFile(path.join(f.directory, "environments.json"), "utf8"), before);
  success(await call(client, "list_projects", { environmentId: "direct" }));
});

test("profile removal coordinates with bounded late OS writes after the browser window exits", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); await start(client);
  const profile = (await saved(f)).pendingProfile;
  const directory = path.join(f.directory, "connect-browser-profiles", profile);
  const lock = await readlink(path.join(directory, "SingletonLock"));
  const pid = Number(lock.match(/-(\d+)$/)?.[1]); assert.ok(pid > 0 && pid !== process.pid);
  // A real OS process models Chromium's late cache/metrics writes. It touches
  // only this fixture's owned cache, never the ownership marker or auth state.
  const writer = spawn(process.execPath, ["--input-type=module", "-e", `
    import { mkdir, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const directory = path.join(process.argv[1], 'late-exit-cache');
    await mkdir(directory); process.send('ready');
    const end = Date.now() + 500; let n = 0;
    while (Date.now() < end) {
      try {
        await mkdir(directory, { recursive: false }).catch(e => { if (e.code !== 'EEXIST') throw e; });
        await Promise.all(Array.from({length: 100}, () => writeFile(path.join(directory, 'entry-' + n++), 'fixture')));
      } catch (e) { if (e.code === 'ENOENT') break; throw e; }
    }
  `, directory], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { if (writer.exitCode === null) writer.kill(); });
  await new Promise((resolve, reject) => { writer.once("message", resolve); writer.once("error", reject); });
  const exited = new Promise((resolve) => writer.once("exit", resolve));
  process.kill(pid, "SIGTERM");
  const result = await terminal(client);
  assert.equal(result.error.code, "connect_auth_cancelled");
  assert.equal(await exited, 0);
  assert.deepEqual(await readdir(path.join(f.directory, "connect-browser-profiles")), []);
});

test("closing the owned window during relay verification cannot save a completed Clerk login", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); const url = await start(client);
  await operatorLogin(url);
  const g = gate(); t.after(g.release); f.control.state.beforeDiscovery = g.wait;
  const completion = terminal(client); completion.catch(() => undefined); await g.entered;
  const profile = (await saved(f)).pendingProfile;
  const lock = await readlink(path.join(f.directory, "connect-browser-profiles", profile, "SingletonLock"));
  const pid = Number(lock.match(/-(\d+)$/)?.[1]); assert.ok(pid > 0 && pid !== process.pid);
  process.kill(pid, "SIGTERM"); await pause(100); g.release();
  const result = await completion;
  assert.equal(result.status, "failed"); assert.equal(result.error.code, "connect_auth_cancelled");
  await client.close(); const restarted = await f.client();
  assert.equal((await status(restarted.client)).status, "signed_out");
});

test("sign-out calls the SDK for only the owned Clerk session and removes its profile without changing environment keys", async (t) => {
  const remote = await startConnectEnvironment("remote"); const f = await fixture(t, [remote]);
  const { client } = await f.client(); await login(client, f.control);
  success(await call(client, "register_connect_environment", { environmentId: "remote" }));
  const before = await readFile(path.join(f.directory, "environments.json"), "utf8"), owned = (await saved(f)).auth;
  success(await call(client, "sign_out_connect"));
  assert.ok(f.control.clerkRequests.some((request) => request.path === `/v1/client/sessions/${owned.sessionId}/end`));
  assert.equal(await readFile(path.join(f.directory, "environments.json"), "utf8"), before);
  assert.deepEqual(await readdir(path.join(f.directory, "connect-browser-profiles")), []);
  success(await call(client, "list_projects", { environmentId: "remote" }));
});

test("sign-out after a process crash clears an orphaned owned login profile even before account verification was saved", async (t) => {
  const f = await fixture(t); const first = await f.client();
  const url = await start(first.client); await operatorLogin(url);
  for (let n = 0; n < 100; n += 1) {
    const state = await fetch(`${f.control.hosted.appUrl}fixture/status`).then((response) => response.json());
    if (state.authenticated) break;
    await pause(100);
  }
  const profile = (await saved(f)).pendingProfile;
  assert.ok(profile);
  process.kill(first.pid(), "SIGKILL"); await pause(300);
  const restarted = await f.client();
  success(await call(restarted.client, "sign_out_connect"));
  assert.deepEqual(await readdir(path.join(f.directory, "connect-browser-profiles")), []);
  assert.equal((await status(restarted.client)).status, "signed_out");
});

test("a delayed SDK sign-out cannot close or remove a newly authenticated owned profile", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); await login(client, f.control);
  const previous = (await saved(f)).auth.browserProfile;
  const g = gate(); t.after(g.release);
  f.control.state.beforeClerk = async (pathname) => { if (pathname.endsWith("/end")) await g.wait(); };
  const signingOut = call(client, "sign_out_connect"); await g.entered;
  const url = await start(client); await operatorLogin(url);
  assert.equal((await terminal(client)).status, "authenticated");
  const next = (await saved(f)).auth.browserProfile; assert.notEqual(next, previous);
  success(await signingOut); g.release();
  assert.ok((await readdir(path.join(f.directory, "connect-browser-profiles"))).includes(next));
  await client.close(); const restarted = await f.client();
  assert.equal((await status(restarted.client)).status, "authenticated");
});

test("sign-out retires a held browser renewal without waiting for service HTTP or restoring cookies on restart", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); await login(client, f.control); await expire(f);
  const g = gate(); t.after(g.release);
  let held = false;
  f.control.state.beforeClerk = async (pathname) => { if (!held && pathname === "/v1/client") { held = true; await g.wait(); } };
  const discovery = call(client, "list_connect_environments"); await g.entered;
  const out = await Promise.race([call(client, "sign_out_connect"), pause(5000).then(() => null)]);
  assert.notEqual(out, null); success(out);
  g.release(); failure(await discovery, "connect_auth_cancelled");
  await client.close(); const restarted = await f.client();
  assert.equal((await status(restarted.client)).status, "signed_out");
  assert.deepEqual(await readdir(path.join(f.directory, "connect-browser-profiles")), []);
});

test("a held old browser login cannot save credentials or affect a newer login after cancellation", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); const url = await start(client);
  await operatorLogin(url);
  const g = gate(); t.after(g.release);
  let held = false;
  f.control.state.beforeClerk = async (pathname) => { if (!held && pathname.endsWith("/tokens/t3-relay")) { held = true; await g.wait(); } };
  const old = terminal(client); old.catch(() => undefined); await g.entered;
  await call(client, "connect_authenticate", { action: "cancel" });
  const next = await start(client);
  f.control.state.beforeClerk = undefined; g.release();
  await old.catch(() => undefined);
  await operatorLogin(next);
  assert.equal((await terminal(client)).status, "authenticated");
  assert.equal((await readdir(path.join(f.directory, "connect-browser-profiles"))).length, 1);
});

test("a stale discovery 401 cannot retire a newer SDK-minted template or profile", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); await login(client, f.control);
  const g = gate(); t.after(g.release); let held = false;
  f.control.state.beforeDiscovery = async () => { if (!held) { held = true; await g.wait(); } };
  const stale = call(client, "list_connect_environments"); await g.entered; await expire(f);
  success(await call(client, "list_connect_environments"));
  f.control.state.discoveryStatus = 401; g.release(); failure(await stale, "connect_auth_expired");
  f.control.state.discoveryStatus = 200;
  assert.equal((await status(client)).status, "authenticated");
});

test("a cancelled renewal's late cleanup cannot close a new browser instance on the same retained profile", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); await login(client, f.control); await expire(f);
  const profile = (await saved(f)).auth.browserProfile;
  const oldRelay = gate(), newTemplate = gate(); t.after(oldRelay.release); t.after(newTemplate.release);
  let held = false;
  f.control.state.beforeDiscovery = async () => { if (!held) { held = true; await oldRelay.wait(); } };
  const old = call(client, "list_connect_environments"); await oldRelay.entered;
  success(await call(client, "connect_authenticate", { action: "cancel" }));
  f.control.state.beforeClerk = async (pathname) => { if (pathname.endsWith("/tokens/t3-relay")) await newTemplate.wait(); };
  const replacement = call(client, "connect_authenticate", { action: "start" }); await newTemplate.entered;
  oldRelay.release(); failure(await old, "connect_auth_cancelled");
  newTemplate.release();
  assert.equal(success(await replacement).authentication.status, "authenticated");
  assert.equal((await saved(f)).auth.browserProfile, profile);
  success(await call(client, "list_connect_environments"));
});

test("template/proof secret reflection is rejected in discovery metadata without exposing browser cookies", async (t) => {
  const remote = await startConnectEnvironment("remote"); const f = await fixture(t, [remote]);
  const { client, stderr } = await f.client(); await login(client, f.control);
  const value = await saved(f);
  const record = { environmentId: "remote", label: "Remote", linkedAt: "2026-09-20T00:00:00Z",
    endpoint: { httpBaseUrl: remote.baseUrl, wsBaseUrl: remote.baseUrl.replace("http", "ws"), providerKind: "cloudflare_tunnel" } };
  for (const secret of [value.auth.accessToken, value.auth.dpopPrivateJwk.d]) {
    for (const field of ["label", "environmentId", "linkedAt"]) {
      f.control.state.environments = [{ ...record, [field]: secret }];
      const result = await call(client, "list_connect_environments"); failure(result, "upstream_incompatible");
      assert.equal(JSON.stringify(result).includes(secret), false);
    }
  }
  assert.equal(stderr(), ""); assert.deepEqual(success(await call(client, "list_environments")).environments, []);
});

test("profile/config association prevents forwarding an existing browser session to a changed hosted origin", async (t) => {
  const f = await fixture(t); const first = await f.client(); await login(first.client, f.control); await first.client.close();
  const count = f.control.clerkRequests.length;
  f.control.env.T3_MCP_CONNECT_HOSTED_APP_URL = "http://127.0.0.1:1";
  const restarted = await f.client();
  failure(await call(restarted.client, "list_connect_environments"), "connect_auth_expired");
  assert.equal(f.control.clerkRequests.length, count);
  success(await call(restarted.client, "sign_out_connect"));
  assert.deepEqual(await readdir(path.join(f.directory, "connect-browser-profiles")), []);
});

test("private storage and profile symlinks fail with sanitized errors", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); await login(client, f.control);
  const file = path.join(f.directory, "connect.json"), before = await readFile(file, "utf8");
  assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  await chmod(file, 0o644); failure(await call(client, "connect_authenticate", { action: "status" }), "storage_error");
  await chmod(file, 0o600);
  const value = JSON.parse(before); value.auth.expiresAt = "invalid"; await writeFile(file, JSON.stringify(value));
  failure(await call(client, "connect_authenticate", { action: "status" }), "storage_error");
  await writeFile(file, before); await expire(f);
  const root = path.join(f.directory, "connect-browser-profiles");
  value.auth.browserProfile = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  value.auth.expiresAt = new Date(0).toISOString(); await writeFile(file, JSON.stringify(value));
  await symlink(f.directory, path.join(root, value.auth.browserProfile));
  const result = await call(client, "list_connect_environments"); failure(result, "storage_error");
  assert.equal(JSON.stringify(result).includes(f.directory), false);
});

test("profile cleanup reports ownership failures and preserves unrelated marked data", async (t) => {
  const f = await fixture(t); const { client } = await f.client(); await login(client, f.control);
  const foreign = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const directory = path.join(f.directory, "connect-browser-profiles", foreign);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(directory, ".t3-mcp-profile.json"), JSON.stringify({ owner: "different-owner", profile: foreign }), { mode: 0o600 });
  const file = path.join(directory, "keep.txt"); await writeFile(file, "preserve unrelated data", { mode: 0o600 });
  failure(await call(client, "sign_out_connect"), "storage_error");
  assert.equal(await readFile(file, "utf8"), "preserve unrelated data");
});

for (const version of [1, 2]) {
  test(`obsolete auth version ${version} requires reauthentication without changing environment sessions or proof keys`, async (t) => {
    const remote = await startConnectEnvironment("remote"); const f = await fixture(t, [remote]);
    const { client } = await f.client(); await login(client, f.control);
    success(await call(client, "register_connect_environment", { environmentId: "remote" }));
    const envFile = path.join(f.directory, "environments.json"), before = await readFile(envFile, "utf8");
    const auth = (await saved(f)).auth;
    await writeFile(path.join(f.directory, "connect.json"), JSON.stringify({ version, auth: {
      accessToken: "obsolete-secret", refreshToken: "obsolete-refresh", nativeClientToken: "obsolete-native",
      accountId: auth.accountId, expiresAt: auth.expiresAt, dpopPrivateJwk: auth.dpopPrivateJwk } }));
    assert.equal((await status(client)).error.code, "connect_auth_expired");
    assert.equal((await saved(f)).version, 3);
    assert.equal(JSON.stringify(await saved(f)).includes("obsolete-"), false);
    assert.equal(await readFile(envFile, "utf8"), before);
    success(await call(client, "list_projects", { environmentId: "remote" }));
  });
}

for (const recovery of [false, true]) {
  test(`cancelling an actual browser auth atomic write survives restart${recovery ? " and retains the previous owned login" : ""}`, { timeout: 40_000 }, async (t) => {
    const f = await fixture(t); const { client } = await f.client();
    if (recovery) { await login(client, f.control); await expire(f); f.control.state.templateResponse = { jwt: "bad" }; }
    const url = await start(client); delete f.control.state.templateResponse;
    if (recovery) {
      const value = await saved(f); value.auth.expiresAt = new Date(Date.now() + 3600_000).toISOString();
      await writeFile(path.join(f.directory, "connect.json"), JSON.stringify(value));
    }
    const small = f.control.state.accessToken;
    f.control.state.accessToken = relaySubjectJwt("t3-code-relay", "connect-account-a", 3600, { fixture_padding: "a".repeat(32 * 1024 * 1024) });
    await operatorLogin(url);
    const g = gate(); t.after(g.release); f.control.state.beforeDiscovery = g.wait;
    const completion = terminal(client); completion.catch(() => undefined); await g.entered;
    let created; const writing = new Promise((resolve) => { created = resolve; });
    const watcher = watch(f.directory, (_event, name) => { if (name?.startsWith(".connect-") && name.endsWith(".tmp")) created(); });
    t.after(() => watcher.close()); g.release(); await writing;
    await call(client, "connect_authenticate", { action: "cancel" });
    await completion.catch(() => undefined); watcher.close();
    f.control.state.beforeDiscovery = undefined; f.control.state.accessToken = small;
    await client.close(); const restarted = await f.client();
    assert.equal((await status(restarted.client)).status, recovery ? "authenticated" : "signed_out");
  });
}
