import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { call, failure, fixture, login, startConnectEnvironment, success } from "./support/connect-http.js";

const attach = (client, environmentId = "remote", extra = {}) => call(client, "attach_connect_environment", {
  environmentId, targetEnvironmentId: environmentId, ...extra,
});
const pair = (client, environment, extra = {}) => call(client, "add_environment", {
  endpoint: environment.baseUrl, grant: "direct-grant", ...extra,
});
const saved = async (client) => success(await call(client, "list_environments")).environments;
const projects = async (client, name, environmentId = "remote") => assert.deepEqual(
  success(await call(client, "list_projects", { environmentId })).projects, [{ id: "project", name }],
);

async function workflow(client, name) {
  await projects(client, name);
  const start = success(await call(client, "start_turn", {
    environmentId: "remote", projectId: "project", prompt: "first",
  })).start;
  assert.equal(start.environmentId, "remote");
  assert.equal(start.outcome, "acknowledged");
  assert.equal("turnId" in start, false);
  const read = success(await call(client, "get_thread", {
    environmentId: "remote", threadId: start.threadId,
  })).thread;
  assert.equal(read.id, start.threadId);
  assert.equal(read.status, "completed");
  assert.equal(read.messages.at(-1).text, "result 1");
  const continuation = success(await call(client, "continue_turn", {
    environmentId: "remote", threadId: start.threadId, prompt: "second",
  })).continuation;
  assert.equal(continuation.outcome, "acknowledged");
  assert.equal(continuation.threadId, start.threadId);
  const final = success(await call(client, "get_thread", {
    environmentId: "remote", threadId: start.threadId,
  })).thread;
  assert.equal(final.status, "completed");
  assert.equal(final.messages.at(-1).text, "result 2");
}

test("attaches legacy direct state without losing its session across Connect workflow, signout, restart and fallback", async (t) => {
  const direct = await startConnectEnvironment("remote", { label: "Direct" });
  const remote = await startConnectEnvironment("remote", { label: "Connect" });
  const other = await startConnectEnvironment("other", { label: "Direct" });
  t.after(() => direct.close());
  const f = await fixture(t, [remote, other]);
  const initial = await f.client();
  success(await pair(initial.client, direct));
  success(await pair(initial.client, other));
  const before = await saved(initial.client);
  await initial.client.close();
  const file = path.join(f.directory, "environments.json");
  // Seed the supported version-one format written before Connect existed.
  const legacy = JSON.parse(await readFile(file, "utf8"));
  for (const registration of Object.values(legacy.environments)) {
    delete registration.accessSource;
    delete registration.directAccess;
  }
  await writeFile(file, JSON.stringify(legacy), { mode: 0o600 });
  const first = await f.client();
  await projects(first.client, "Direct");
  await login(first.client, f.control);
  success(await call(first.client, "list_connect_environments"));
  assert.deepEqual(await saved(first.client), before);
  const registration = success(await attach(first.client)).environment;
  assert.equal(registration.id, "remote");
  assert.equal(registration.label, "Direct");
  assert.equal(registration.source, "connect");
  assert.equal(registration.connectAttached, true);
  assert.deepEqual(await saved(first.client), [before.find((entry) => entry.id === "other"), registration]);
  await workflow(first.client, "Connect");
  assert.equal(direct.commands.length, 0);
  success(await call(first.client, "sign_out_connect"));
  f.control.state.outage = true;
  await first.client.close();
  const restarted = await f.client();
  assert.deepEqual(await saved(restarted.client), [before.find((entry) => entry.id === "other"), registration]);
  await projects(restarted.client, "Connect");
  const relayCount = f.control.relayRequests.length;
  remote.sessions.clear();
  await workflow(restarted.client, "Direct");
  await projects(restarted.client, "Direct", "other");
  assert.equal(f.control.relayRequests.length, relayCount);
  assert.deepEqual(direct.commands.map((command) => command.type), ["thread.create", "thread.turn.start", "thread.turn.start"]);
  assert.equal(remote.commands.length, 3);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(f.directory)).sort(), ["connect-browser-profiles", "environments.json"]);
  const state = await readFile(file, "utf8");
  assert.equal(state.includes("bootstrap-"), false);
  assert.equal(state.includes(f.control.state.accessToken), false);
  assert.equal(initial.stderr() + first.stderr() + restarted.stderr(), "");
});

test("direct re-pair rejects a different or missing identity before consuming a grant and preserves attached access", async (t) => {
  const direct = await startConnectEnvironment("remote", { label: "Direct" });
  const remote = await startConnectEnvironment("remote", { label: "Connect" });
  const impostor = await startConnectEnvironment("impostor", { label: "Direct" });
  t.after(() => direct.close());
  const f = await fixture(t, [remote, impostor]);
  const { client } = await f.client();
  success(await pair(client, direct));
  await login(client, f.control);
  success(await attach(client));
  const before = await saved(client);
  for (const [identity, code] of [["impostor", "environment_conflict"], [undefined, "upstream_incompatible"], ["", "upstream_incompatible"]]) {
    impostor.state.descriptorOverrides = { environmentId: identity };
    failure(await pair(client, impostor, { environmentId: "remote" }), code);
    assert.equal(impostor.requests.some((request) => request.path === "/oauth/token"), false);
    assert.deepEqual(await saved(client), before);
    await projects(client, "Connect");
  }
});

test("same-label discovery never merges registrations and attachment requires complete matching upstream identity", async (t) => {
  const direct = await startConnectEnvironment("remote", { label: "Same label" });
  const remote = await startConnectEnvironment("remote", { label: "Same label" });
  const other = await startConnectEnvironment("other", { label: "Same label" });
  t.after(() => direct.close());
  const f = await fixture(t, [remote, other]);
  const { client } = await f.client();
  success(await pair(client, direct));
  const before = await saved(client);
  await login(client, f.control);
  assert.equal(success(await call(client, "list_connect_environments")).environments.length, 2);
  assert.deepEqual(await saved(client), before);
  failure(await call(client, "register_connect_environment", { environmentId: "remote" }), "environment_exists");
  failure(await attach(client, "other", { targetEnvironmentId: "remote" }), "connect_identity_mismatch");
  assert.equal(f.control.relayRequests.some((request) => request.method === "POST"), false);

  for (const identity of ["other", undefined, ""]) {
    f.control.state.connectOverrides = { environmentId: identity };
    failure(await attach(client), "connect_identity_mismatch");
    assert.equal(remote.requests.length, 0);
    assert.deepEqual(await saved(client), before);
    await projects(client, "Same label");
  }
  f.control.state.connectOverrides = undefined;
  for (const [identity, code] of [["other", "connect_identity_mismatch"], [undefined, "upstream_incompatible"], ["", "upstream_incompatible"]]) {
    remote.state.descriptorOverrides = { environmentId: identity };
    failure(await attach(client), code);
    assert.equal(remote.requests.some((request) => request.path === "/oauth/token"), false);
    assert.deepEqual(await saved(client), before);
    await projects(client, "Same label");
  }
  remote.state.descriptorOverrides = undefined;
  success(await attach(client));
  success(await call(client, "register_connect_environment", { environmentId: "other" }));
  const registrations = await saved(client);
  assert.deepEqual(registrations.map((entry) => entry.id), ["other", "remote"]);
  assert.deepEqual(registrations.map((entry) => entry.label), ["Same label", "Same label"]);
  assert.equal(other.commands.length, 0);
});

test("failed attachment and re-pair leave working access intact; successful direct re-pair retains Connect and selects direct", async (t) => {
  const direct = await startConnectEnvironment("remote", { label: "Direct" });
  const remote = await startConnectEnvironment("remote", { label: "Connect" });
  t.after(() => direct.close());
  const f = await fixture(t, [remote]);
  const { client, stderr } = await f.client();
  success(await pair(client, direct));
  await login(client, f.control);
  const directOnly = await saved(client);
  remote.state.rejectGrant = true;
  failure(await attach(client), "pairing_rejected");
  assert.deepEqual(await saved(client), directOnly);
  await projects(client, "Direct");
  remote.state.rejectGrant = false;
  const registration = success(await attach(client)).environment;
  const attached = await saved(client);
  for (const [field, value, code] of [
    ["rejectGrant", true, "pairing_rejected"],
    ["tokenOverrides", { scope: "orchestration:read" }, "permission_denied"],
    ["sessionOverrides", { authenticated: false }, "pairing_rejected"],
  ]) {
    remote.state[field] = value;
    failure(await attach(client), code);
    remote.state[field] = undefined;
    assert.deepEqual(await saved(client), attached);
    await projects(client, "Connect");
    direct.state[field] = value;
    failure(await pair(client, direct, { environmentId: "remote" }), code);
    direct.state[field] = undefined;
    assert.deepEqual(await saved(client), attached);
    await projects(client, "Connect");
  }
  const repaired = success(await pair(client, direct, { environmentId: "remote" })).environment;
  assert.equal(repaired.id, registration.id);
  assert.equal(repaired.connectAttached, true);
  assert.equal(repaired.source, undefined);
  assert.deepEqual(await saved(client), [repaired]);
  await workflow(client, "Direct");
  assert.equal(remote.commands.length, 0);
  success(await call(client, "sign_out_connect"));
  await client.close();
  const restarted = await f.client();
  assert.deepEqual(await saved(restarted.client), [repaired]);
  await projects(restarted.client, "Direct");
  direct.sessions.clear();
  await workflow(restarted.client, "Connect");
  assert.equal(remote.commands.length, 3);
  assert.equal(stderr() + restarted.stderr(), "");
});

function pauseExchange(environment, t) {
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  environment.state.beforeExchange = async () => {
    environment.state.beforeExchange = undefined;
    entered();
    await gate;
  };
  t.after(release);
  return { entered: started, release };
}

for (const [pendingOperation, winner] of [["attachment", "re-pair"], ["re-pair", "attachment"], ["attachment", "attachment"]]) {
  test(`concurrent ${winner} wins without stale ${pendingOperation} overwriting its access`, { timeout: 30_000 }, async (t) => {
    const direct = await startConnectEnvironment("remote", { label: "Direct" });
    const remote = await startConnectEnvironment("remote", { label: "Connect" });
    t.after(() => direct.close());
    const f = await fixture(t, [remote]);
    const { client, stderr } = await f.client();
    success(await pair(client, direct));
    await login(client, f.control);
    success(await attach(client));
    const pause = pauseExchange(pendingOperation === "attachment" ? remote : direct, t);
    const stale = pendingOperation === "attachment"
      ? attach(client, "remote", { label: "Stale" })
      : pair(client, direct, { environmentId: "remote", label: "Stale" });
    await pause.entered;
    const update = winner === "attachment"
      ? attach(client, "remote", { label: "Winner" })
      : pair(client, direct, { environmentId: "remote", label: "Winner" });
    success(await update);
    const current = await saved(client);
    pause.release();
    failure(await stale, "environment_conflict");
    assert.deepEqual(await saved(client), current);
    assert.equal(current.length, 1);
    assert.equal(current[0].connectAttached, true);
    await projects(client, winner === "attachment" ? "Connect" : "Direct");
    await client.close();
    const restarted = await f.client();
    assert.deepEqual(await saved(restarted.client), current);
    await projects(restarted.client, winner === "attachment" ? "Connect" : "Direct");
    assert.equal(stderr() + restarted.stderr(), "");
  });
}
