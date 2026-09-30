import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture, login, call, success, failure } from "./support/connect-http.js";

test("Desktop native login owns a Clerk client/session and verifies its template at relay discovery", async (t) => {
  const f = await fixture(t);
  const { client, stderr } = await f.client();
  await login(client, f.control);
  const saved = JSON.parse(await readFile(path.join(f.directory, "connect.json"), "utf8"));
  assert.equal(saved.version, 2);
  assert.equal(saved.auth.nativeClientToken, f.control.state.nativeClientToken);
  assert.equal(saved.auth.sessionId, "sess_owned");
  assert.equal(saved.auth.accountId, "connect-account-a");
  assert.equal(saved.auth.refreshToken, undefined);
  assert.equal(f.control.clerkRequests[0].path, "/v1/client");
  assert.ok(f.control.clerkRequests.some((request) => request.path.endsWith("/tokens/t3-relay")));
  assert.equal(f.control.relayRequests[0].path, "/v1/environments");
  const status = success(await call(client, "connect_authenticate", { action: "status" }));
  assert.equal(JSON.stringify(status).includes("native-client-secret"), false);
  assert.equal(stderr(), "");
});

test("one native credential owner prevents two stdio processes from replaying a rotating client token", async (t) => {
  const f = await fixture(t);
  const first = await f.client();
  await login(first.client, f.control);
  const second = await f.client();
  const count = f.control.clerkRequests.length;
  failure(await call(second.client, "list_connect_environments"), "storage_error");
  assert.equal(f.control.clerkRequests.length, count);
  await first.client.close();
  assert.equal(success(await call(second.client, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
});

test("restart rehydrates the owned native client before trusting a cached template JWT", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  await login(client, f.control);
  await client.close();
  const before = f.control.clerkRequests.length;
  f.control.state.sessionStatus = "revoked";
  const restarted = await f.client();
  const result = await call(restarted.client, "list_connect_environments");
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "connect_auth_expired");
  assert.ok(f.control.clerkRequests.length > before);
});

test("concurrent short-template renewal uses rotating native bearer credentials without another login", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  await login(client, f.control);
  const file = path.join(f.directory, "connect.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.auth.expiresAt = new Date(0).toISOString();
  await writeFile(file, JSON.stringify(saved));
  await Promise.all([call(client, "list_connect_environments"), call(client, "list_connect_environments")].map(async (result) => success(await result)));
  assert.equal(f.control.clerkRequests.filter((request) => request.path.endsWith("/tokens/t3-relay")).length, 2);
  assert.equal(f.control.clerkRequests.filter((request) => request.path === "/v1/client/sign_ins").length, 1);
  const rotated = JSON.parse(await readFile(file, "utf8"));
  assert.equal(rotated.auth.nativeClientToken, f.control.state.nativeClientToken);
});
