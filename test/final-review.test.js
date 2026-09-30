import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { call, failure, fixture, login, startConnectEnvironment, success } from "./support/connect-http.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("successful project and thread payloads reject credential reflection in text and identifiers", async (t) => {
  const remote = await startConnectEnvironment("remote");
  const f = await fixture(t, [remote]);
  const { client, stderr } = await f.client();
  success(await call(client, "add_environment", { endpoint: remote.baseUrl, grant: "direct-grant" }));
  await login(client, f.control);
  success(await call(client, "attach_connect_environment", { environmentId: "remote", targetEnvironmentId: "remote" }));
  const start = success(await call(client, "start_turn", { environmentId: "remote", projectId: "project", prompt: "first" })).start;
  const privateState = JSON.parse(await readFile(path.join(f.directory, "environments.json"), "utf8"));
  const secrets = [privateState.environments.remote.accessToken, privateState.environments.remote.dpopPrivateJwk.d,
    privateState.environments.remote.directAccess.accessToken];
  for (const secret of secrets) {
    for (const field of ["id", "title"]) {
      remote.state.projectSnapshot = (snapshot) => { snapshot.projects[0][field] = `prefix-${secret}`; return snapshot; };
      const result = await call(client, "list_projects", { environmentId: "remote" });
      assert.equal(JSON.stringify(result).includes(secret), false, "project output must exclude credentials");
      failure(result, "upstream_incompatible");
    }
    remote.state.projectSnapshot = undefined;
    for (const reflect of [
      (thread) => { thread.title = secret; },
      (thread) => { thread.projectId = secret; },
      (thread) => { thread.messages = thread.messages.map((message) => ({ ...message, text: secret })); },
      (thread) => { thread.messages = thread.messages.map((message) => ({ ...message, id: secret })); },
      ...["role", "turnId", "createdAt", "updatedAt"].map((field) =>
        (thread) => { thread.messages = thread.messages.map((message) => ({ ...message, [field]: secret })); }),
      (thread) => { thread.session.status = secret; },
      (thread) => { thread.activities = [{ id: "activity", kind: "info", tone: "info", summary: secret, turnId: null, createdAt: "2026-09-30" }]; },
    ]) {
      remote.state.threadSnapshot = (snapshot) => { snapshot.thread = structuredClone(snapshot.thread); reflect(snapshot.thread); return snapshot; };
      const result = await call(client, "get_thread", { environmentId: "remote", threadId: start.threadId });
      assert.equal(JSON.stringify(result).includes(secret), false, "thread output must exclude credentials");
      failure(result, "upstream_incompatible");
    }
    remote.state.threadSnapshot = (snapshot) => { snapshot.page.beforeCursor = secret; return snapshot; };
    const paginated = await call(client, "get_thread", { environmentId: "remote", threadId: start.threadId });
    assert.equal(JSON.stringify(paginated).includes(secret), false, "pagination output must exclude credentials");
    failure(paginated, "upstream_incompatible");
    remote.state.threadSnapshot = undefined;
  }
  assert.equal(secrets.some((secret) => stderr().includes(secret)), false);
});

for (const boundary of ["beforeRelayExchange", "beforeConnect", "beforeDescriptor", "beforeExchange", "beforeSession"]) {
  test(`sign-out and new login retire registration held at ${boundary}`, async (t) => {
    const remote = await startConnectEnvironment("remote");
    const f = await fixture(t, [remote]);
    const { client } = await f.client();
    await login(client, f.control);
    const arrived = deferred();
    const release = deferred();
    t.after(release.resolve);
    const state = boundary === "beforeRelayExchange" || boundary === "beforeConnect" ? f.control.state : remote.state;
    state[boundary] = async () => { state[boundary] = undefined; arrived.resolve(); await release.promise; };
    const registration = call(client, "register_connect_environment", { environmentId: "remote" });
    await arrived.promise;
    success(await call(client, "sign_out_connect"));
    await login(client, f.control);
    const networkCount = remote.requests.length + f.control.relayRequests.length;
    release.resolve();
    failure(await registration, "connect_auth_cancelled");
    assert.equal(remote.requests.length + f.control.relayRequests.length, networkCount, "retired work must not start another network operation");
    assert.deepEqual(success(await call(client, "list_environments")).environments, []);
    assert.equal(success(await call(client, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
  });
}

for (const source of ["connect", "direct"]) {
  test(`an initial ${source} registration cannot resurrect an identity added and unregistered during exchange`, async (t) => {
    const remote = await startConnectEnvironment("remote");
    const other = await startConnectEnvironment("other");
    const f = await fixture(t, [remote, other]);
    const { client } = await f.client();
    await login(client, f.control);
    const arrived = deferred();
    const release = deferred();
    t.after(release.resolve);
    remote.state.beforeExchange = async () => { remote.state.beforeExchange = undefined; arrived.resolve(); await release.promise; };
    const stale = source === "connect"
      ? call(client, "register_connect_environment", { environmentId: "remote" })
      : call(client, "add_environment", { endpoint: remote.baseUrl, grant: "direct-grant" });
    await arrived.promise;
    success(await call(client, "add_environment", { endpoint: remote.baseUrl, grant: "direct-grant" }));
    success(await call(client, "unregister_environment", { environmentId: "remote" }));
    success(await call(client, "add_environment", { endpoint: other.baseUrl, grant: "direct-grant" }));
    release.resolve();
    failure(await stale, "environment_conflict");
    assert.deepEqual(success(await call(client, "list_environments")).environments.map((entry) => entry.id), ["other"]);
    await client.close();
    const restarted = await f.client();
    assert.deepEqual(success(await call(restarted.client, "list_environments")).environments.map((entry) => entry.id), ["other"]);
  });
}
