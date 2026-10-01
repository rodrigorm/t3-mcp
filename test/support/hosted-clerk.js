import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function browserExecutable() {
  if (process.env.T3_MCP_CONNECT_BROWSER_EXECUTABLE) return process.env.T3_MCP_CONNECT_BROWSER_EXECUTABLE;
  const candidates = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/usr/bin/google-chrome", "/usr/bin/chromium"];
  const cache = path.join(os.homedir(), ".agent-browser", "browsers");
  for (const entry of await readdir(cache).catch(() => [])) {
    candidates.push(path.join(cache, entry, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"));
    candidates.push(path.join(cache, entry, "chrome-linux64/chrome"));
  }
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch {} }
  throw new Error("Browser tests require installed Chrome/Edge or T3_MCP_CONNECT_BROWSER_EXECUTABLE.");
}

async function server(handler) {
  const listener = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    try { await handler(request, response, Buffer.concat(chunks).toString()); }
    catch { response.writeHead(401, { "content-type": "application/json" }); response.end('{"error":"fixture_contract_rejected"}'); }
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${listener.address().port}`,
    close: () => new Promise((resolve) => { listener.closeAllConnections(); listener.close(resolve); }) };
}
function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
const controls = new Map();

// An external HTTP service fixture, not a connector/browser mock. Its page owns
// the UI, provider redirect, MFA and cookie lifecycle. Node uses only public Clerk SDK methods.
export async function startHostedClerk(state, mintJwt) {
  const requests = [], owners = [], cookies = new Map(), nonces = new Map();
  let rotations = 0;
  function rotate(response, owner) {
    if (owner.cookie) cookies.delete(owner.cookie);
    owner.cookie = `fixture-browser-client-${++rotations}-${randomUUID()}`;
    state.browserCookie = owner.cookie;
    cookies.set(owner.cookie, owner);
    response.setHeader("set-cookie", `__client=${owner.cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`);
  }
  function session(owner) {
    if (!owner.authenticated || state.sessionStatus === "revoked" || state.sessionExpiresAt <= Date.now()) return null;
    return { id: owner.sessionId, status: state.tasks?.length ? "pending" : "active",
      user: { id: state.accountId ?? "connect-account-a" }, currentTask: state.tasks?.[0] ?? null };
  }
  const provider = await server(async (request, response, body) => {
    const url = new URL(request.url, provider.baseUrl);
    const nonce = url.searchParams.get("state") ?? new URLSearchParams(body).get("state");
    const owner = nonces.get(nonce); assert.ok(owner);
    requests.push({ method: request.method, path: `provider${url.pathname}` });
    if (request.method === "POST" && url.pathname === "/verify") {
      assert.equal(new URLSearchParams(body).get("code"), "654321");
      owner.providerVerified = true;
      response.writeHead(303, { location: `${app.baseUrl}/callback?state=${nonce}` }); response.end(); return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<h1>Fixture external provider MFA</h1><form method="POST" action="/verify"><input name="state" type="hidden" value="${nonce}"><label>Authenticator code <input name="code"></label><button>Verify</button></form><script>setTimeout(()=>{document.querySelector('[name=code]').value='654321';document.querySelector('form').requestSubmit()},100)</script>`);
  });
  const app = await server(async (request, response, body) => {
    const url = new URL(request.url, app.baseUrl);
    const cookie = request.headers.cookie?.match(/(?:^|; )__client=([^;]+)/)?.[1];
    let owner = cookies.get(cookie);
    if (url.pathname === "/fixture/operator" && request.method === "POST") {
      const pending = owners.findLast((entry) => entry.modal && !entry.authenticated);
      if (!pending) return json(response, { ready: false }, 409);
      pending.command = JSON.parse(body).flow ?? "direct";
      return json(response, { ready: true });
    }
    if (url.pathname === "/fixture/status") return json(response, { authenticated: owners.at(-1)?.authenticated ?? false });
    if (url.pathname === "/fixture/action") return json(response, { action: owner?.command ?? null });
    if (url.pathname === "/fixture/modal") { assert.ok(owner); owner.modal = true; return json(response, {}); }
    if (url.pathname === "/callback") {
      const returned = nonces.get(url.searchParams.get("state"));
      assert.ok(returned && returned === owner && owner.providerVerified);
      nonces.delete(url.searchParams.get("state")); owner.authenticated = true;
      rotate(response, owner); response.writeHead(303, { location: "/" }); response.end(); return;
    }
    if (url.pathname === "/provider/start") {
      assert.ok(owner); const nonce = randomUUID(); nonces.set(nonce, owner);
      response.writeHead(303, { location: `${provider.baseUrl}/authorize?state=${nonce}` }); response.end(); return;
    }
    if (url.pathname.startsWith("/v1/")) {
      requests.push({ method: request.method, path: url.pathname, headers: request.headers, body });
      assert.equal(request.headers.authorization, undefined);
      if (!owner && url.pathname === "/v1/client") {
        owner = { sessionId: `sess_browser_${owners.length + 1}`, authenticated: false };
        owners.push(owner);
      }
      assert.ok(owner);
      rotate(response, owner);
      await state.beforeClerk?.(url.pathname, request.method);
      if (state.clerkStatus) return json(response, { error: "session_expired" }, state.clerkStatus);
      if (url.pathname === "/v1/client") return json(response, { session: session(owner) });
      if (url.pathname === "/v1/sign_in") {
        const form = new URLSearchParams(body);
        assert.equal(form.get("identifier"), "operator@example.test");
        assert.equal(form.get("password"), "operator-password");
        owner.authenticated = true;
        return json(response, { session: session(owner) });
      }
      if (url.pathname.endsWith("/end")) {
        assert.equal(url.pathname, `/v1/client/sessions/${owner.sessionId}/end`);
        owner.authenticated = false; return json(response, {});
      }
      if (url.pathname.endsWith("/tokens/t3-relay")) {
        assert.equal(url.pathname, `/v1/client/sessions/${owner.sessionId}/tokens/t3-relay`);
        assert.equal(request.method, "POST"); assert.equal(new URLSearchParams(body).get("skip_cache"), "true");
        assert.ok(session(owner)?.status === "active");
        if (state.templateLifetime) state.accessToken = mintJwt("t3-code-relay", state.accountId ?? "connect-account-a", state.templateLifetime);
        return json(response, Object.hasOwn(state, "templateResponse") ? state.templateResponse : { jwt: state.accessToken });
      }
      return json(response, {}, 404);
    }
    if (url.pathname !== "/") return json(response, {}, 404);
    response.setHeader("content-type", "text/html; charset=utf-8"); response.setHeader("cache-control", "no-store");
    response.end(`<!doctype html><title>Fixture T3 Connect</title><h1>Connect your computers</h1><button id="signin">Sign in to T3 Connect</button><div id="modal" hidden><h2>Official service sign-in fixture</h2><button id="provider">External provider</button><form id="direct"><label>Email <input name="identifier" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form></div><script>
let queue=Promise.resolve();
function request(url,fields){const next=queue.then(async()=>{const response=await fetch(url,fields?{method:'POST',body:new URLSearchParams(fields)}:{});if(!response.ok)throw Error('Service authentication failed');return response.json()});queue=next.catch(()=>{});return next}
function install(value){window.Clerk.session=value?{...value,getToken:async options=>{if(options.template!=='t3-relay'||options.skipCache!==true)throw Error('Wrong SDK token options');const latest=await request('/v1/client');if(!latest.session||latest.session.status!=='active')return null;install(latest.session);return (await request('/v1/client/sessions/'+latest.session.id+'/tokens/t3-relay',{skip_cache:'true'})).jwt}}:null;window.Clerk.user=value?.user??null}
window.Clerk={loaded:false,session:null,user:null,openSignIn:async()=>{document.querySelector('#modal').hidden=false;await fetch('/fixture/modal');},signOut:async options=>{await request('/v1/client/sessions/'+options.sessionId+'/end',{});install(null)}};
document.querySelector('#signin').onclick=()=>Clerk.openSignIn();document.querySelector('#provider').onclick=()=>location.href='/provider/start';document.querySelector('#direct').onsubmit=async event=>{event.preventDefault();install((await request('/v1/sign_in',Object.fromEntries(new FormData(event.target)))).session)};
request('/v1/client').then(value=>{install(value.session);Clerk.loaded=true});
const operator=setInterval(async()=>{if(!Clerk.loaded||Clerk.session||document.querySelector('#modal').hidden)return;const action=(await fetch('/fixture/action').then(r=>r.json())).action;if(!action)return;clearInterval(operator);if(action==='provider_mfa'){document.querySelector('#provider').click();return;}document.querySelector('[name=identifier]').value='operator@example.test';document.querySelector('[name=password]').value='operator-password';document.querySelector('#direct').requestSubmit()},100);
</script>`);
  });
  const control = { state, requests, appUrl: `${app.baseUrl}/`,
    async operator(flow = "direct") {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const response = await fetch(`${app.baseUrl}/fixture/operator`, { method: "POST", body: JSON.stringify({ flow }) });
        if (response.ok) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("The actual browser did not open the service sign-in UI.");
    }, close: async () => { controls.delete(app.baseUrl); await app.close(); await provider.close(); } };
  controls.set(app.baseUrl, control);
  return control;
}

export async function operatorLogin(url, flow = "direct") {
  const control = controls.get(new URL(url).origin);
  assert.ok(control, "Operator fixture requires its own controlled hosted application.");
  await control.operator(flow);
}
