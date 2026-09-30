import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";
import { ACCESS_TYPE, EXCHANGE, SCOPES, relaySubjectJwt, startConnectControl, startConnectEnvironment } from "./support/connect-http.js";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("base64url");
function keyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const { crv, kty, x, y } = pair.publicKey.export({ format: "jwk" });
  return { ...pair, jwk: { crv, kty, x, y }, jkt: hash(JSON.stringify({ crv, kty, x, y })) };
}
function proof(key, url, method, token, claims = {}, header = {}) {
  const input = `${encode({ typ: "dpop+jwt", alg: "ES256", jwk: key.jwk, ...header })}.${encode({
    htm: method, htu: url, iat: Math.floor(Date.now() / 1000), jti: randomUUID(),
    ...(token ? { ath: hash(token) } : {}), ...claims,
  })}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

test("controlled environment enforces signed DPoP claims, token/key binding, bootstrap consumption, and replay", async (t) => {
  const environment = await startConnectEnvironment("remote");
  t.after(() => environment.close());
  const key = keyPair();
  const tokenUrl = `${environment.baseUrl}/oauth/token`;
  const grant = environment.mint(key.jkt);
  const form = new URLSearchParams({ grant_type: EXCHANGE, subject_token: grant,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap", requested_token_type: ACCESS_TYPE, scope: SCOPES });
  const exchange = (key) => fetch(tokenUrl, { method: "POST", headers: { dpop: proof(key, tokenUrl, "POST"),
    "content-type": "application/x-www-form-urlencoded" }, body: form });
  assert.equal((await exchange(keyPair())).status, 401);
  const response = await exchange(key);
  assert.equal(response.status, 200);
  const token = (await response.json()).access_token;
  assert.equal((await exchange(key)).status, 401);
  const url = `${environment.baseUrl}/api/orchestration/snapshot`;
  const read = (dpop, type = "DPoP") => fetch(`${url}?ignored=query`, { headers: { authorization: `${type} ${token}`, dpop } });
  const valid = proof(key, url, "GET", token);
  assert.equal((await read(valid)).status, 200);
  assert.equal((await read(valid)).status, 401);
  for (const dpop of [
    proof(key, url, "POST", token), proof(key, `${url}/`, "GET", token),
    proof(key, `${url}?ignored=query`, "GET", token), proof(key, url, "GET", "wrong-token"),
    proof(key, url, "GET", token, { jti: "" }), proof(key, url, "GET", token, { iat: 0 }),
    proof(key, url, "GET", token, { iat: Math.floor(Date.now() / 1000) + 60 }),
    proof(key, url, "GET", token, { iat: 1.5 }), proof(key, url, "GET", token, {}, { alg: "none" }),
    proof(key, url, "GET", token, {}, { jwk: { ...key.jwk, d: "forbidden-private-key" } }),
    proof(keyPair(), url, "GET", token), valid.slice(0, -8) + "invalid!",
  ]) assert.equal((await read(dpop)).status, 401);
  assert.equal((await read(proof(key, url, "GET", token), "Bearer")).status, 401);
});

test("controlled relay enforces exact no-slash resource and audience, signature, scopes, and fresh exchange proofs", async (t) => {
  const control = await startConnectControl([]);
  t.after(() => control.close());
  const key = keyPair();
  const origin = control.env.T3_MCP_CONNECT_RELAY_URL;
  const url = `${origin}/v1/client/dpop-token`;
  const form = { grant_type: EXCHANGE, subject_token: control.state.accessToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt", requested_token_type: ACCESS_TYPE,
    resource: origin, scope: "environment:connect", client_id: "t3-web" };
  const exchange = (fields, dpop = proof(key, url, "POST")) => fetch(url, { method: "POST",
    headers: { dpop, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...form, ...fields }) });
  for (const fields of [{ resource: `${origin}/` }, { subject_token: "opaque-token" },
    { subject_token: relaySubjectJwt("wrong-audience") },
    { subject_token: control.state.accessToken.slice(0, -8) + "invalid!" }, { scope: "orchestration:operate" },
    { subject_token_type: ACCESS_TYPE }, { client_id: "t3-mcp" }]) assert.equal((await exchange(fields)).status, 401);
  const valid = proof(key, url, "POST");
  assert.equal((await exchange({}, valid)).status, 200);
  assert.equal((await exchange({}, valid)).status, 401);
});
