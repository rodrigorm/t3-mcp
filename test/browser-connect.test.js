import assert from "node:assert/strict";
import test from "node:test";
import { fixture, call, success } from "./support/connect-http.js";

test("Connect starts an actual owned headed browser at the hosted root and delegates external provider plus MFA to the service UI", async (t) => {
  const f = await fixture(t);
  const { client } = await f.client();
  const auth = success(await call(client, "connect_authenticate")).authentication;
  assert.equal(auth.status, "pending");
  assert.equal(auth.authorizationUrl, f.control.hosted.appUrl);
  assert.equal(auth.browserOpened, true);
  await f.control.hosted.operator("provider_mfa");
  const deadline = Date.now() + 15_000;
  let result;
  do {
    result = success(await call(client, "connect_authenticate", { action: "status" })).authentication;
    if (result.status !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(result.status, "authenticated", result.error?.message);
  assert.ok(f.control.clerkRequests.some((request) => request.path === "provider/verify"));
  assert.ok(f.control.clerkRequests.some((request) => request.path.endsWith("/tokens/t3-relay")));
  assert.equal(f.control.relayRequests[0].path, "/v1/environments");
});
