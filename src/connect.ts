import { ConnectorError } from "./errors.js";
import { createDpopProof, dpopThumbprint, generateDpopKey } from "./dpop.js";
import { ConnectStore, type ConnectAuth } from "./storage.js";
import { safePayload } from "./secrets.js";
import { pairConnectEnvironment } from "./upstream.js";
import { parseEndpoint } from "./url.js";
import { NativeClerk, type NativeConfig, type LoginView } from "./native-clerk.js";
import { localLogin, type LocalLogin } from "./local-login.js";
import type { DpopPrivateJwk, PairingResult } from "./types.js";

const AUTH_TIMEOUT_MS = 10 * 60 * 1_000;
const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const RELAY_ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

export type ConnectAuthState = "signed_out" | "pending" | "authenticated" | "failed" | "cancelled";
export interface PublicConnectAuth {
  readonly status: ConnectAuthState;
  readonly authorizationUrl?: string;
  readonly expiresAt?: string;
  readonly error?: { readonly code: string; readonly message: string };
}
export interface ConnectEnvironment {
  readonly id: string;
  readonly label: string;
  readonly endpoint: string;
  readonly linkedAt: string;
}
interface ConnectConfig extends NativeConfig {
  readonly relayClientId: "t3-web" | "t3-mobile";
  readonly callbackPort: number;
}
interface PendingAuthorization {
  readonly ui: LocalLogin;
  readonly expiresAt: string;
  readonly key: DpopPrivateJwk;
  readonly timer: NodeJS.Timeout;
  readonly generation: number;
  readonly clerk: NativeClerk;
}

function firstSetting(...names: string[]): string | undefined {
  for (const name of names) { const value = process.env[name]?.trim(); if (value) return value; }
  return undefined;
}
function normalizedUrl(value: string, allowLoopbackHttp: boolean): string {
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase());
    if (url.protocol !== "https:" && !(allowLoopbackHttp && loopback && url.protocol === "http:")) throw new Error();
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    return url.toString();
  } catch { throw new ConnectorError("connect_not_configured", "The T3 Connect endpoint configuration is invalid."); }
}
function config(): ConnectConfig {
  const port = firstSetting("T3_MCP_CONNECT_CALLBACK_PORT") ?? "0";
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new ConnectorError("connect_not_configured", "The local Connect UI port configuration is invalid.");
  const publishableKey = firstSetting("T3_MCP_CONNECT_CLERK_PUBLISHABLE_KEY", "T3_MCP_CLERK_PUBLISHABLE_KEY", "T3CODE_CLERK_PUBLISHABLE_KEY") ?? "pk_live_Y2xlcmsudDMuY29kZXMk";
  let frontendHost: string;
  try {
    if (!/^pk_(live|test)_/.test(publishableKey)) throw new Error();
    frontendHost = Buffer.from(publishableKey.split("_").slice(2).join("_"), "base64").toString("utf8");
    if (!/^[a-zA-Z0-9.-]+\$$/.test(frontendHost)) throw new Error();
  } catch { throw new ConnectorError("connect_not_configured", "The Clerk publishable key configuration is invalid."); }
  const jwtTemplate = firstSetting("T3_MCP_CONNECT_CLERK_JWT_TEMPLATE", "T3CODE_CLERK_JWT_TEMPLATE") ?? "t3-relay";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jwtTemplate)) throw new ConnectorError("connect_not_configured", "The Clerk JWT template configuration is invalid.");
  return {
    publishableKey, jwtTemplate,
    frontendApiUrl: normalizedUrl(firstSetting("T3_MCP_CONNECT_FRONTEND_API_URL") ?? `https://${frontendHost.slice(0, -1)}`, true),
    relayUrl: normalizedUrl(firstSetting("T3_MCP_CONNECT_RELAY_URL", "T3_MCP_RELAY_URL", "T3CODE_RELAY_URL") ?? "https://relay.t3.codes", true),
    relayClientId: firstSetting("T3_MCP_RELAY_CLIENT_ID") === "t3-mobile" ? "t3-mobile" : "t3-web",
    callbackPort: Number(port),
  };
}
function associated(auth: ConnectAuth, settings: NativeConfig): boolean {
  return ["frontendApiUrl", "publishableKey", "jwtTemplate", "relayUrl"].every((key) =>
    auth[key as keyof NativeConfig] === settings[key as keyof NativeConfig]);
}
function publicAuth(status: ConnectAuthState, pending?: PendingAuthorization, error?: { code: string; message: string }): PublicConnectAuth {
  return { status, ...(pending ? { authorizationUrl: pending.ui.authorizationUrl, expiresAt: pending.expiresAt } : {}), ...(error ? { error } : {}) };
}
async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new ConnectorError("upstream_incompatible", "T3 Connect returned invalid JSON."); }
}
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try { return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }); }
  catch { throw new ConnectorError("connect_unavailable", "T3 Connect could not be reached safely."); }
}
function connectErrorForStatus(status: number): ConnectorError {
  if (status === 401) return new ConnectorError("connect_auth_expired", "T3 Connect authentication expired; authenticate again.");
  if (status === 403) return new ConnectorError("connect_permission_denied", "T3 Connect denied this operation.");
  if (status === 404) return new ConnectorError("connect_environment_not_found", "The selected Connect environment is unavailable.");
  return new ConnectorError("connect_unavailable", status >= 500 ? "T3 Connect is temporarily unavailable." : "T3 Connect rejected the request.");
}
function parseConnectEnvironment(value: unknown, secrets: readonly string[]): ConnectEnvironment {
  if (!value || typeof value !== "object") throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid environment.");
  safePayload(value, secrets);
  const environment = value as Record<string, unknown>;
  const endpoint = environment.endpoint as Record<string, unknown> | undefined;
  if (typeof environment.environmentId !== "string" || !environment.environmentId.trim() ||
    typeof environment.label !== "string" || !environment.label.trim() ||
    typeof environment.linkedAt !== "string" || !environment.linkedAt.trim() || !endpoint || typeof endpoint !== "object" ||
    typeof endpoint.httpBaseUrl !== "string" || typeof endpoint.wsBaseUrl !== "string" ||
    !["manual", "cloudflare_tunnel", "t3_relay"].includes(String(endpoint.providerKind))) {
    throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid environment endpoint.");
  }
  try {
    const httpBaseUrl = normalizedUrl(endpoint.httpBaseUrl, true);
    const ws = new URL(endpoint.wsBaseUrl);
    if (!["ws:", "wss:"].includes(ws.protocol)) throw new Error();
    normalizedUrl(ws.toString().replace(/^ws/, "http"), true);
    return { id: environment.environmentId.trim(), label: environment.label.trim(), endpoint: httpBaseUrl, linkedAt: environment.linkedAt };
  } catch { throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid environment endpoint."); }
}

export class ConnectManager {
  private pending: PendingAuthorization | undefined;
  private last: PublicConnectAuth = { status: "signed_out" };
  private lifecycle = 0;
  private starting: Promise<PublicConnectAuth> | undefined;
  private readonly secrets = new Set<string>();
  private validatedSession: string | undefined;
  private refreshing: { readonly generation: number; readonly token: Promise<ConnectAuth> } | undefined;

  constructor(private readonly store: ConnectStore) {}

  async authenticate(action: "start" | "status" | "cancel" = "start"): Promise<PublicConnectAuth> {
    if (action === "status") return this.status();
    if (action === "cancel") return this.cancel();
    if (this.starting) return this.starting;
    const starting = this.startAuthentication();
    this.starting = starting;
    try { return await starting; } finally { if (this.starting === starting) this.starting = undefined; }
  }

  private async startAuthentication(): Promise<PublicConnectAuth> {
    const lifecycle = this.lifecycle;
    if (this.pending) return publicAuth("pending", this.pending);
    const existing = await this.store.read();
    if (existing) {
      try { await this.authToken(); this.requireLifecycle(lifecycle); return { status: "authenticated" }; }
      catch (error) {
        if (!(error instanceof ConnectorError) || !["connect_auth_expired", "upstream_incompatible"].includes(error.code)) throw error;
      }
    }
    this.requireLifecycle(lifecycle);
    await this.store.invalidateWrites();
    this.requireLifecycle(lifecycle);
    const settings = config();
    const generation = this.store.generation;
    const assertActive = () => { this.requireLifecycle(lifecycle); this.requireGeneration(generation); };
    const clerk = new NativeClerk(settings, "", async (token) => {
      assertActive(); this.secrets.add(token);
      if (!await this.store.stageNative(token, settings.frontendApiUrl, generation)) this.requireGeneration(-1);
    }, assertActive);
    const ui = await localLogin(settings.callbackPort, async (fields) => {
      assertActive();
      const pending = this.pending;
      if (!pending || pending.clerk !== clerk) this.requireGeneration(-1);
      if (fields.get("action") === "cancel") { await this.cancel(); return { step: "cancelled" }; }
      try {
        let view: LoginView;
        switch (fields.get("action")) {
          case "identify": {
            const identifier = fields.get("identifier")?.trim();
            if (!identifier || identifier.length > 1024) throw new ConnectorError("invalid_input", "Enter an account identifier in this browser.");
            this.secrets.add(identifier);
            view = await clerk.identify(identifier); break;
          }
          case "choose": view = await clerk.choose(fields.get("strategy") ?? ""); break;
          case "verify": {
            const value = fields.get("password") ?? fields.get("code");
            if (!value || value.length > 1024) throw new ConnectorError("invalid_input", "Enter the requested verification in this browser.");
            this.secrets.add(value);
            view = await clerk.verify(value); break;
          }
          default: throw new ConnectorError("invalid_input", "Unsupported local login action.");
        }
        assertActive();
        if (view.step === "complete") await this.completeLogin(pending!, settings);
        return view;
      } catch (error) {
        if (error instanceof ConnectorError && this.pending === pending) {
          this.last = publicAuth("pending", pending, { code: error.code, message: error.message });
          // Input errors remain retryable. Actual lifecycle/ownership failures end the flow.
          if (["connect_auth_expired", "connect_account_conflict", "upstream_incompatible"].includes(error.code)) await this.finishPending(error, pending);
        }
        throw error;
      }
    }, assertActive);
    if (lifecycle !== this.lifecycle) { ui.close(); this.requireLifecycle(lifecycle); }
    const pending: PendingAuthorization = { ui, clerk, generation, key: generateDpopKey(),
      expiresAt: new Date(Date.now() + AUTH_TIMEOUT_MS).toISOString(),
      timer: setTimeout(() => { void this.finishPending(new ConnectorError("connect_auth_expired", "T3 Connect authorization expired; authenticate again."), pending); }, AUTH_TIMEOUT_MS) };
    this.pending = pending;
    this.last = publicAuth("pending", pending);
    return this.last;
  }

  private async completeLogin(pending: PendingAuthorization, settings: ConnectConfig): Promise<void> {
    const active = () => { this.requireGeneration(pending.generation); if (this.pending !== pending) this.requireGeneration(-1); };
    const owner = await pending.clerk.ownedSession(); active();
    const existing = await this.store.read(); active();
    if (existing && (!existing.accountId || existing.accountId !== owner.accountId)) {
      throw new ConnectorError("connect_account_conflict", "A different T3 Connect account is retained; sign out before switching accounts.");
    }
    const token = await pending.clerk.template(owner.sessionId, owner.accountId); active();
    this.secrets.add(token.accessToken);
    const { frontendApiUrl, publishableKey, jwtTemplate, relayUrl } = settings;
    const auth: ConnectAuth = { frontendApiUrl, publishableKey, jwtTemplate, relayUrl, ...owner, ...token,
      nativeClientToken: pending.clerk.token, dpopPrivateJwk: pending.key };
    await this.discover(settings, auth, active); active();
    if (!await this.store.replace(auth, pending.generation)) this.requireGeneration(-1);
    active(); this.validatedSession = auth.sessionId; this.stopPending(); this.last = { status: "authenticated" };
  }

  async status(): Promise<PublicConnectAuth> {
    if (this.pending) return this.last.status === "pending" ? this.last : publicAuth("pending", this.pending);
    const existing = await this.store.read();
    if (!existing) return this.last;
    if (this.last.status === "failed") return this.last;
    try { await this.authToken(); return { status: "authenticated" }; }
    catch (error) {
      if (!(error instanceof ConnectorError) || error.code === "storage_error") throw error;
      return publicAuth("failed", undefined, { code: error.code, message: error.message });
    }
  }

  async cancel(): Promise<PublicConnectAuth> {
    this.lifecycle += 1;
    const drained = this.store.invalidateWrites();
    this.starting = undefined; this.stopPending();
    const cancelled = publicAuth("cancelled", undefined, { code: "connect_auth_cancelled", message: "T3 Connect authorization was cancelled." });
    this.last = cancelled;
    const generation = this.store.generation;
    await drained; await this.store.discardPending(generation);
    return cancelled;
  }

  async signOut(): Promise<{ readonly signedOut: boolean }> {
    const reading = this.store.read();
    const cancelled = this.cancel();
    const lifecycle = this.lifecycle;
    const clearing = this.store.clear();
    this.validatedSession = undefined;
    this.secrets.clear();
    const existing = await reading;
    await cancelled;
    const signedOut = await clearing;
    if (lifecycle === this.lifecycle && !this.pending) this.last = { status: "signed_out" };
    // Only end the session we own, with its own native credential/config association.
    if (existing?.nativeClientToken && existing.sessionId) {
      try {
        if (associated(existing, config())) {
          await new NativeClerk(existing, existing.nativeClientToken, async () => undefined, () => undefined).end(existing.sessionId);
        }
      }
      catch { /* Local logout succeeds even when the remote session is already revoked/unreachable. */ }
    }
    return { signedOut };
  }

  private async discover(settings: ConnectConfig, auth: ConnectAuth, active: () => void): Promise<readonly ConnectEnvironment[]> {
    this.remember(auth);
    const response = await fetchWithTimeout(`${settings.relayUrl}v1/environments`, { method: "GET", headers: { authorization: `Bearer ${auth.accessToken}` } });
    active();
    if (!response.ok) throw connectErrorForStatus(response.status);
    const value = await responseJson(response); active();
    if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).environments)) throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid environment list.");
    return (value as { environments: unknown[] }).environments.map((entry) => parseConnectEnvironment(entry, [...this.secrets]));
  }

  async listEnvironments(): Promise<readonly ConnectEnvironment[]> {
    const generation = this.store.generation;
    const auth = await this.authToken();
    try { return await this.discover(config(), auth, () => this.requireGeneration(generation)); }
    catch (error) { if (error instanceof ConnectorError && error.code === "connect_auth_expired") await this.invalidateAuth(auth, generation); throw error; }
  }

  private async authToken(): Promise<ConnectAuth> {
    const generation = this.store.generation;
    if (this.refreshing?.generation === generation) return this.refreshing.token;
    const token = this.loadAuthToken(generation); this.refreshing = { generation, token };
    try { return await token; }
    catch (error) {
      if (generation === this.store.generation && error instanceof ConnectorError && ["connect_auth_expired", "connect_account_conflict", "upstream_incompatible"].includes(error.code)) {
        this.last = publicAuth("failed", undefined, { code: error.code, message: error.message });
      }
      throw error;
    } finally { if (this.refreshing?.token === token) this.refreshing = undefined; }
  }

  private async loadAuthToken(generation: number): Promise<ConnectAuth> {
    let auth = await this.store.read(); this.requireGeneration(generation);
    const settings = config();
    if (!auth?.nativeClientToken || !auth.sessionId || !auth.accountId || !associated(auth, settings)) throw new ConnectorError("connect_auth_expired", "Desktop native reauthentication is required; start the local browser login.");
    this.remember(auth);
    if (this.validatedSession === auth.sessionId && Date.parse(auth.expiresAt) > Date.now() + 5_000) return auth;
    const active = () => this.requireGeneration(generation);
    const clerk = new NativeClerk(settings, auth.nativeClientToken, async (nativeClientToken) => {
      active(); this.secrets.add(nativeClientToken);
      const rotated = { ...auth!, nativeClientToken };
      if (!await this.store.replace(rotated, generation, auth!)) this.requireGeneration(-1);
      auth = rotated;
    }, active);
    try {
      await clerk.ownedSession(auth.sessionId, auth.accountId); active();
      const token = await clerk.template(auth.sessionId, auth.accountId); active();
      this.secrets.add(token.accessToken);
      const refreshed = { ...auth, ...token, nativeClientToken: clerk.token };
      await this.discover(settings, refreshed, active); active();
      if (!await this.store.replace(refreshed, generation, auth)) this.requireGeneration(-1);
      this.validatedSession = refreshed.sessionId;
      this.last = { status: "authenticated" }; return refreshed;
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "connect_auth_expired") await this.invalidateAuth(auth, generation);
      throw error;
    }
  }

  private async invalidateAuth(auth: ConnectAuth, generation: number): Promise<void> {
    const saved = await this.store.replace({ ...auth, expiresAt: new Date(0).toISOString(), nativeClientToken: "", accessToken: "" }, generation, auth);
    this.requireGeneration(generation);
    if (saved) this.last = publicAuth("failed", undefined, { code: "connect_auth_expired", message: "T3 Connect authentication expired; authenticate again." });
  }
  private requireGeneration(generation: number): void {
    this.store.assertOwner();
    if (generation !== this.store.generation) throw new ConnectorError("connect_auth_cancelled", "T3 Connect authorization is no longer active.");
  }
  private requireLifecycle(lifecycle: number): void {
    if (lifecycle !== this.lifecycle) throw new ConnectorError("connect_auth_cancelled", "T3 Connect authorization is no longer pending.");
  }
  private stopPending(): void {
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.ui.close(); }
  }
  private async finishPending(error: ConnectorError, expected: PendingAuthorization | undefined): Promise<void> {
    if (!expected || this.pending !== expected) return;
    const drained = this.store.invalidateWrites(); this.stopPending();
    const generation = this.store.generation;
    this.last = publicAuth("failed", undefined, { code: error.code, message: error.message });
    await drained; await this.store.discardPending(generation);
  }
  private remember(auth: ConnectAuth): void {
    for (const secret of [auth.accessToken, auth.nativeClientToken, auth.dpopPrivateJwk.d]) if (secret) this.secrets.add(secret);
  }

  async connectEnvironment(environmentId: string): Promise<{ readonly environment: ConnectEnvironment; readonly pairing: PairingResult;
    readonly accountId?: string; readonly credential: string; readonly assertActive: () => void }> {
    const selectedId = environmentId.trim();
    if (!selectedId) throw new ConnectorError("invalid_input", "environmentId is required.");
    const settings = config(), generation = this.store.generation, lifecycle = this.lifecycle;
    const assertActive = () => { this.requireGeneration(generation); this.requireLifecycle(lifecycle); };
    const auth = await this.authToken(); assertActive();
    const environments = await this.listEnvironments(); assertActive();
    const environment = environments.find((entry) => entry.id === selectedId);
    if (!environment) throw new ConnectorError("connect_environment_not_found", "The selected Connect environment is unavailable.");
    const relayToken = await this.relayAccessToken(settings, auth, assertActive); assertActive();
    const key = auth.dpopPrivateJwk;
    const connectUrl = `${settings.relayUrl}v1/environments/${encodeURIComponent(selectedId)}/connect`;
    const response = await fetchWithTimeout(connectUrl, { method: "POST", headers: {
      authorization: `DPoP ${relayToken}`, dpop: createDpopProof({ key, method: "POST", url: connectUrl, accessToken: relayToken }),
      "content-type": "application/json" }, body: JSON.stringify({ clientProofKeyThumbprint: dpopThumbprint(key) }) });
    assertActive();
    if (response.status === 401) throw new ConnectorError("upstream_incompatible", "T3 Connect rejected the relay proof or session; verify the upstream DPoP contract or use direct pairing.");
    if (!response.ok) throw connectErrorForStatus(response.status);
    const value = await responseJson(response); assertActive();
    if (!value || typeof value !== "object") throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid environment credential.");
    const result = value as Record<string, unknown>;
    if (result.environmentId !== selectedId) throw new ConnectorError("connect_identity_mismatch", "T3 Connect did not prove the selected environment identity; select it again or use direct pairing.");
    if (typeof result.credential !== "string" || !result.credential.trim() || /\s/.test(result.credential) ||
      typeof result.expiresAt !== "string" || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()) {
      throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid or expired bootstrap credential; select the environment again or use direct pairing.");
    }
    this.secrets.add(relayToken); this.secrets.add(result.credential);
    const connectedEnvironment = parseConnectEnvironment({ environmentId: result.environmentId, endpoint: result.endpoint,
      label: environment.label, linkedAt: environment.linkedAt }, [...this.secrets]);
    if ((result.endpoint as Record<string, unknown>).providerKind !== "cloudflare_tunnel") throw new ConnectorError("upstream_incompatible", "T3 Connect registration requires a ready managed cloudflare_tunnel endpoint; use direct pairing for other providers.");
    const pairing = await pairConnectEnvironment(parseEndpoint(connectedEnvironment.endpoint, result.credential), key, selectedId, assertActive);
    assertActive();
    return { environment: connectedEnvironment, pairing, credential: result.credential, assertActive, accountId: auth.accountId! };
  }

  private async relayAccessToken(settings: ConnectConfig, auth: ConnectAuth, assertActive: () => void): Promise<string> {
    assertActive();
    const url = `${settings.relayUrl}v1/client/dpop-token`;
    const response = await fetchWithTimeout(url, { method: "POST", headers: {
      dpop: createDpopProof({ key: auth.dpopPrivateJwk, method: "POST", url }), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: TOKEN_EXCHANGE_GRANT_TYPE, subject_token: auth.accessToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt", requested_token_type: RELAY_ACCESS_TOKEN_TYPE,
        resource: new URL(settings.relayUrl).origin, scope: "environment:connect", client_id: settings.relayClientId }) });
    assertActive();
    if (response.status === 400 || response.status === 401) throw new ConnectorError("upstream_incompatible", "T3 Connect rejected the relay JWT or DPoP exchange; verify the upstream client authorization contract or use direct pairing.");
    if (!response.ok) throw connectErrorForStatus(response.status);
    const value = await responseJson(response); assertActive();
    const relay = value as Record<string, unknown>;
    if (!value || typeof value !== "object" || typeof relay.access_token !== "string" || !relay.access_token.trim() || /\s/.test(relay.access_token) ||
      relay.issued_token_type !== RELAY_ACCESS_TOKEN_TYPE || relay.token_type !== "DPoP" || typeof relay.expires_in !== "number" ||
      !Number.isInteger(relay.expires_in) || relay.expires_in <= 0 || relay.expires_in > 1800 || relay.scope !== "environment:connect") {
      throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid relay session.");
    }
    this.secrets.add(relay.access_token); return relay.access_token;
  }
}
