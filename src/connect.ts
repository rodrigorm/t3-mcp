import { randomUUID } from "node:crypto";

import { ConnectorError } from "./errors.js";
import { createDpopProof, dpopThumbprint, generateDpopKey } from "./dpop.js";
import { ConnectStore, type ConnectAuth } from "./storage.js";
import { safePayload } from "./secrets.js";
import { pairConnectEnvironment } from "./upstream.js";
import { parseEndpoint } from "./url.js";
import { BrowserProfiles, type BrowserAuthConfig } from "./browser-auth.js";
import type { DpopPrivateJwk, PairingResult } from "./types.js";

const AUTH_TIMEOUT_MS = 10 * 60 * 1_000;
const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const RELAY_ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

export type ConnectAuthState = "signed_out" | "pending" | "authenticated" | "failed" | "cancelled";
export interface PublicConnectAuth {
  readonly status: ConnectAuthState;
  readonly authorizationUrl?: string;
  readonly expiresAt?: string;
  readonly browserOpened?: boolean;
  readonly message?: string;
  readonly error?: { readonly code: string; readonly message: string };
}
export interface ConnectEnvironment {
  readonly id: string;
  readonly label: string;
  readonly endpoint: string;
  readonly linkedAt: string;
}
interface ConnectConfig extends BrowserAuthConfig {
  readonly relayClientId: "t3-web" | "t3-mobile";
}
interface PendingAuthorization {
  readonly profile: string;
  readonly settings: ConnectConfig;
  readonly expiresAt: string;
  readonly key: DpopPrivateJwk;
  readonly timer: NodeJS.Timeout;
  readonly generation: number;
  ready: boolean;
  poll?: Promise<PublicConnectAuth>;
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
  const jwtTemplate = firstSetting("T3_MCP_CONNECT_CLERK_JWT_TEMPLATE", "T3CODE_CLERK_JWT_TEMPLATE") ?? "t3-relay";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jwtTemplate)) throw new ConnectorError("connect_not_configured", "The Clerk JWT template configuration is invalid.");
  return {
    jwtTemplate,
    hostedAppUrl: normalizedUrl(firstSetting("T3_MCP_CONNECT_HOSTED_APP_URL", "T3CODE_HOSTED_APP_URL") ?? "https://app.t3.codes", true),
    relayUrl: normalizedUrl(firstSetting("T3_MCP_CONNECT_RELAY_URL", "T3_MCP_RELAY_URL", "T3CODE_RELAY_URL") ?? "https://relay.t3.codes", true),
    relayClientId: firstSetting("T3_MCP_RELAY_CLIENT_ID") === "t3-mobile" ? "t3-mobile" : "t3-web",
  };
}
function associated(auth: ConnectAuth, settings: BrowserAuthConfig): boolean {
  return ["hostedAppUrl", "jwtTemplate", "relayUrl"].every((key) =>
    auth[key as keyof BrowserAuthConfig] === settings[key as keyof BrowserAuthConfig]);
}
function publicAuth(status: ConnectAuthState, pending?: PendingAuthorization, error?: { code: string; message: string }): PublicConnectAuth {
  return { status, ...(pending ? { authorizationUrl: pending.settings.hostedAppUrl, expiresAt: pending.expiresAt,
    browserOpened: pending.ready, message: pending.ready
      ? "A connector-owned browser was opened. Complete T3 Connect sign-in using any option offered by the official UI."
      : "The connector-owned browser is opening." } : {}), ...(error ? { error } : {}) };
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
  private validatedProfile: string | undefined;
  private readonly browser: BrowserProfiles;
  private refreshing: { readonly generation: number; readonly token: Promise<ConnectAuth> } | undefined;

  constructor(private readonly store: ConnectStore) { this.browser = new BrowserProfiles(store.directory); }

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
    const pending: PendingAuthorization = { profile: randomUUID(), settings, generation, key: generateDpopKey(), ready: false,
      expiresAt: new Date(Date.now() + AUTH_TIMEOUT_MS).toISOString(),
      timer: setTimeout(() => { void this.finishPending(new ConnectorError("connect_auth_expired", "T3 Connect authorization expired; authenticate again."), pending); }, AUTH_TIMEOUT_MS) };
    this.pending = pending;
    try {
      if (!await this.store.stageProfile(pending.profile, generation)) this.requireGeneration(-1);
      await this.browser.open(pending.profile, settings, true, assertActive);
      assertActive();
      pending.ready = true;
      this.last = publicAuth("pending", pending);
    } catch (error) {
      if (this.pending === pending && error instanceof ConnectorError) await this.finishPending(error, pending);
      else await this.browser.discard(pending.profile);
      throw error;
    }
    return this.last;
  }

  private async pollPending(pending: PendingAuthorization): Promise<PublicConnectAuth> {
    if (!pending.ready) return publicAuth("pending", pending);
    if (pending.poll) return pending.poll;
    const poll = this.completeLogin(pending);
    pending.poll = poll;
    try { return await poll; } finally { if (pending.poll === poll) pending.poll = undefined; }
  }

  private async completeLogin(pending: PendingAuthorization): Promise<PublicConnectAuth> {
    let flushing = false;
    const active = () => {
      this.requireGeneration(pending.generation);
      if (this.pending !== pending) this.requireGeneration(-1);
      if (!flushing) this.browser.assertOpen(pending.profile);
    };
    try {
      const grant = await this.browser.read(pending.profile, pending.settings, active);
      active();
      if (!grant) return publicAuth("pending", pending);
      const existing = await this.store.read(); active();
      if (existing && (!existing.accountId || existing.accountId !== grant.accountId)) {
        throw new ConnectorError("connect_account_conflict", "A different T3 Connect account is retained; sign out before switching accounts.");
      }
      this.secrets.add(grant.accessToken);
      const { hostedAppUrl, jwtTemplate, relayUrl } = pending.settings;
      const auth: ConnectAuth = { hostedAppUrl, jwtTemplate, relayUrl, ...grant,
        browserProfile: pending.profile, dpopPrivateJwk: pending.key };
      await this.discover(pending.settings, auth, active); active();
      flushing = true;
      await this.browser.close(pending.profile); active();
      if (!await this.store.replace(auth, pending.generation)) this.requireGeneration(-1);
      active();
      this.validatedProfile = auth.browserProfile;
      this.stopPending(); this.last = { status: "authenticated" };
      if (existing?.browserProfile && existing.browserProfile !== auth.browserProfile) await this.browser.discard(existing.browserProfile);
      return this.last;
    } catch (error) {
      if (error instanceof ConnectorError && this.pending === pending) {
        await this.finishPending(error, pending);
        return this.last;
      }
      throw error;
    }
  }

  async status(): Promise<PublicConnectAuth> {
    if (this.pending) return this.pollPending(this.pending);
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
    const pending = this.pending;
    this.starting = undefined; this.stopPending();
    const cancelled = publicAuth("cancelled", undefined, { code: "connect_auth_cancelled", message: "T3 Connect authorization was cancelled." });
    this.last = cancelled;
    const generation = this.store.generation;
    // Capture the browsers now, before another start can create a newer profile.
    const closing = this.browser.closeAll();
    await closing;
    if (pending) await this.browser.discard(pending.profile);
    await drained; await this.store.discardPending(generation);
    return cancelled;
  }

  async signOut(): Promise<{ readonly signedOut: boolean }> {
    const reading = this.store.read();
    const cancelled = this.cancel();
    const lifecycle = this.lifecycle;
    const clearing = this.store.clear();
    const generation = this.store.generation;
    this.validatedProfile = undefined;
    this.secrets.clear();
    const existing = await reading;
    await cancelled;
    const signedOut = await clearing;
    if (lifecycle === this.lifecycle && !this.pending) this.last = { status: "signed_out" };
    // The SDK signs out only this connector's session; environment sessions are independent.
    if (existing?.browserProfile) {
      try {
        if (associated(existing, config())) {
          await this.browser.signOut(existing.browserProfile, existing.sessionId, existing);
        } else await this.browser.discard(existing.browserProfile);
      }
      catch { await this.browser.discard(existing.browserProfile); }
    }
    await this.browser.discardAll(() => this.lifecycle === lifecycle && this.store.generation === generation);
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
    const auth = await this.store.read(); this.requireGeneration(generation);
    const settings = config();
    if (!auth?.browserProfile || !auth.sessionId || !auth.accountId || !associated(auth, settings)) throw new ConnectorError("connect_auth_expired", "Connect reauthentication is required; start the owned browser login.");
    this.remember(auth);
    if (this.validatedProfile === auth.browserProfile && Date.parse(auth.expiresAt) > Date.now() + 5_000) return auth;
    const active = () => this.requireGeneration(generation);
    try {
      await this.browser.open(auth.browserProfile, settings, false, active);
      const grant = await this.browser.read(auth.browserProfile, settings, active); active();
      if (!grant) throw new ConnectorError("connect_auth_expired", "The owned Clerk browser session expired or needs operator sign-in. Start authentication again.");
      if (grant.accountId !== auth.accountId) throw new ConnectorError("connect_account_conflict", "A different T3 Connect account was returned; sign out before switching accounts.");
      this.secrets.add(grant.accessToken);
      const refreshed = { ...auth, ...grant };
      await this.discover(settings, refreshed, active); active();
      if (!await this.store.replace(refreshed, generation, auth)) this.requireGeneration(-1);
      await this.browser.close(auth.browserProfile); active();
      this.validatedProfile = refreshed.browserProfile;
      this.last = { status: "authenticated" }; return refreshed;
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "connect_auth_expired") await this.invalidateAuth(auth, generation);
      throw error;
    } finally { await this.browser.close(auth.browserProfile); }
  }

  private async invalidateAuth(auth: ConnectAuth, generation: number): Promise<void> {
    const saved = await this.store.replace({ ...auth, expiresAt: new Date(0).toISOString(), accessToken: "" }, generation, auth);
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
    if (pending) clearTimeout(pending.timer);
  }
  private async finishPending(error: ConnectorError, expected: PendingAuthorization | undefined): Promise<void> {
    if (!expected || this.pending !== expected) return;
    const drained = this.store.invalidateWrites(); this.stopPending();
    const generation = this.store.generation;
    this.last = publicAuth("failed", undefined, { code: error.code, message: error.message });
    await this.browser.discard(expected.profile);
    await drained; await this.store.discardPending(generation);
  }
  private remember(auth: ConnectAuth): void {
    for (const secret of [auth.accessToken, auth.dpopPrivateJwk.d]) if (secret) this.secrets.add(secret);
  }

  async shutdown(): Promise<void> {
    this.lifecycle += 1;
    await this.store.invalidateWrites();
    const pending = this.pending; this.stopPending();
    await this.browser.closeAll();
    if (pending) {
      await this.browser.discard(pending.profile);
      await this.store.discardPending();
    }
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
