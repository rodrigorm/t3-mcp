import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { ConnectorError } from "./errors.js";
import type { LoginView } from "./native-clerk.js";

export interface LocalLogin {
  readonly authorizationUrl: string;
  close(): void;
}

function loginPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>T3 Connect login</title>
<h1>T3 Connect login</h1>
<p>Sign in to an existing account. Credentials stay between this local page and Clerk.</p>
<p id="message" role="status"></p>
<form id="form">
  <label id="label">Email or account identifier <input name="identifier" autocomplete="username" required maxlength="1024"></label>
  <button>Continue</button>
</form>
<div id="choices"></div>
<button id="cancel" type="button">Cancel login</button>
<script nonce="${nonce}">
const capability = location.hash.slice(1);
history.replaceState(null, '', '/login');
let action = 'identify';
const form = document.querySelector('#form');
const message = document.querySelector('#message');
const choices = document.querySelector('#choices');

async function post(fields) {
  const response = await fetch('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ capability, ...fields }),
  });
  const view = await response.json();
  if (!response.ok) { message.textContent = view.message; return; }
  choices.replaceChildren();
  if (view.step === 'complete' || view.step === 'cancelled') {
    form.remove();
    document.querySelector('#cancel').remove();
    message.textContent = view.step === 'complete'
      ? 'T3 Connect login verified. You may close this window.'
      : 'T3 Connect login cancelled. You may close this window.';
    return;
  }
  if (view.step === 'factor') {
    action = 'verify';
    message.textContent = view.second
      ? 'Complete the required second factor or client-trust verification.'
      : 'Complete the first factor.';
    const input = form.querySelector('input');
    input.value = '';
    input.name = view.selected === 'password' ? 'password' : 'code';
    input.type = view.selected === 'password' ? 'password' : 'text';
    input.autocomplete = view.selected === 'password' ? 'current-password' : 'one-time-code';
    document.querySelector('#label').firstChild.textContent = view.selected === 'password' ? 'Password ' : view.selected + ' code ';
    for (const strategy of view.strategies) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = strategy;
      button.onclick = () => post({ action: 'choose', strategy });
      choices.append(button);
    }
  }
}
form.onsubmit = async event => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(form));
  form.querySelector('input').value = '';
  await post({ action, ...fields });
};
document.querySelector('#cancel').onclick = () => post({ action: 'cancel' });
</script>
</html>`;
}

/** A capability-protected operator UI. It has no upstream credential delivery endpoint. */
export async function localLogin(port: number, submit: (fields: URLSearchParams) => Promise<LoginView>, active: () => void): Promise<LocalLogin> {
  const capability = randomBytes(32).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  let origin = "";
  let busy = false;
  const server: Server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    try {
      active();
      if (request.headers.host !== new URL(origin).host || request.url !== "/login") { response.writeHead(403); response.end(); return; }
      if (request.method === "GET") {
        if (request.headers.origin && request.headers.origin !== origin) { response.writeHead(403); response.end(); return; }
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(loginPage(nonce));
        return;
      }
      if (request.method !== "POST") { response.writeHead(405, { allow: "GET, POST" }); response.end(); return; }
      if (request.headers.origin !== origin || request.headers["content-type"] !== "application/x-www-form-urlencoded") {
        response.writeHead(403); response.end(); return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 8192) { response.writeHead(413); response.end(); return; }
      }
      const fields = new URLSearchParams(body);
      if (fields.getAll("capability").length !== 1 || fields.get("capability") !== capability) { response.writeHead(403); response.end(); return; }
      if ([...fields.keys()].some((key) => fields.getAll(key).length !== 1)) { response.writeHead(400); response.end(); return; }
      active();
      const cancelling = fields.get("action") === "cancel";
      if (busy && !cancelling) { response.writeHead(409); response.end(); return; }
      if (!cancelling) busy = true;
      try {
        const view = await submit(fields);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(view));
      } finally { if (!cancelling) busy = false; }
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: error instanceof ConnectorError ? error.message : "Local login failed. Start authentication again." }));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  } catch { throw new ConnectorError("connect_auth_failed", "The local login UI could not start; check its configured port."); }
  const address = server.address();
  if (!address || typeof address === "string") throw new ConnectorError("connect_auth_failed", "The local login UI could not start.");
  origin = `http://127.0.0.1:${address.port}`;
  return { authorizationUrl: `${origin}/login#${capability}`, close() { server.close(); server.closeIdleConnections(); } };
}
