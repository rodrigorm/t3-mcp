import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";

import { ConnectorError } from "./errors.js";
import { createDpopProof, dpopThumbprint, generateDpopKey } from "./dpop.js";
import { ConnectStore, type ConnectAuth } from "./storage.js";
import { pairConnectEnvironment } from "./upstream.js";
import { parseEndpoint } from "./url.js";
import type { DpopPrivateJwk, PairingResult } from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 10 * 60 * 1_000;
const AUTH_REFRESH_WINDOW_MS = 60_000;
const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const RELAY_JWT_SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
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

interface ConnectConfig {
  readonly relayUrl: string;
  readonly tokenEndpoint: string;
  readonly hostedAppUrl: string;
  readonly clientId: string;
  readonly relayClientId: "t3-web" | "t3-mobile";
}

interface PendingAuthorization {
  readonly state: string;
  readonly verifier: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
  readonly key: DpopPrivateJwk;
  readonly server: HttpServer;
  readonly timer: NodeJS.Timeout;
}

function firstSetting(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function requiredSetting(name: string, ...names: string[]): string {
  const value = firstSetting(name, ...names);
  if (!value) throw new ConnectorError("connect_not_configured", "T3 Connect is not configured.");
  return value;
}

function normalizedUrl(value: string, allowLoopbackHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError("connect_not_configured", "The T3 Connect endpoint configuration is invalid.");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(allowLoopbackHttp && loopback && url.protocol === "http:")) {
    throw new ConnectorError("connect_not_configured", "The T3 Connect endpoint configuration is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConnectorError("connect_not_configured", "The T3 Connect endpoint configuration is invalid.");
  }
  url.pathname = "/";
  return url.toString();
}

function configuredUrl(value: string, allowLoopbackHttp: boolean, preservePath: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError("connect_not_configured", "The T3 Connect endpoint configuration is invalid.");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(allowLoopbackHttp && loopback && url.protocol === "http:")) {
    throw new ConnectorError("connect_not_configured", "The T3 Connect endpoint configuration is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConnectorError("connect_not_configured", "The T3 Connect endpoint configuration is invalid.");
  }
  if (!preservePath) url.pathname = "/";
  return url.toString();
}

function tokenEndpointFromPublishableKey(key: string): string {
  const encoded = key.split("_").slice(2).join("_");
  try {
    const hostname = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
    if (!hostname || hostname.includes("/") || hostname.includes(" ")) throw new Error();
    return `https://${hostname}/oauth/token`;
  } catch {
    throw new ConnectorError("connect_not_configured", "The T3 Connect authentication configuration is invalid.");
  }
}

function config(): ConnectConfig {
  const relayUrl = normalizedUrl(
    requiredSetting("T3_MCP_CONNECT_RELAY_URL", "T3_MCP_RELAY_URL", "T3CODE_RELAY_URL"),
    true,
  );
  const tokenEndpoint = configuredUrl(
    firstSetting("T3_MCP_CONNECT_TOKEN_ENDPOINT") ??
      tokenEndpointFromPublishableKey(
        requiredSetting(
          "T3_MCP_CONNECT_CLERK_PUBLISHABLE_KEY",
          "T3_MCP_CLERK_PUBLISHABLE_KEY",
          "T3CODE_CLERK_PUBLISHABLE_KEY",
        ),
      ),
    true,
    true,
  );
  const hostedAppUrl = configuredUrl(
    firstSetting("T3_MCP_CONNECT_HOSTED_APP_URL", "T3_MCP_HOSTED_APP_URL", "T3CODE_HOSTED_APP_URL") ??
      "https://app.t3.codes",
    false,
    false,
  );
  return {
    relayUrl,
    tokenEndpoint,
    hostedAppUrl,
    clientId: requiredSetting(
      "T3_MCP_CONNECT_CLIENT_ID",
      "T3_MCP_CLERK_CLIENT_ID",
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
    ),
    relayClientId: firstSetting("T3_MCP_RELAY_CLIENT_ID") === "t3-mobile" ? "t3-mobile" : "t3-web",
  };
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeJwtSubject(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const part = value.split(".")[1];
  if (!part) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof claims.sub === "string" && claims.sub.trim() ? claims.sub.trim() : undefined;
  } catch {
    return undefined;
  }
}

function oauthChallenge(verifier: string): string {
  return base64Url(requireHash(verifier));
}

function requireHash(value: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function randomBase64Url(bytes: number): string {
  return base64Url(randomBytes(bytes));
}

function publicAuth(status: ConnectAuthState, pending?: PendingAuthorization, error?: { code: string; message: string }): PublicConnectAuth {
  return {
    status,
    ...(pending
      ? { authorizationUrl: pending.authorizationUrl, expiresAt: pending.expiresAt }
      : {}),
    ...(error ? { error } : {}),
  };
}

function safeAuthFailure(code: "connect_auth_failed" | "connect_auth_expired" | "connect_auth_cancelled", message: string): ConnectorError {
  return new ConnectorError(code, message);
}

async function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new ConnectorError("connect_auth_failed", "The local Connect callback could not start.");
  }
  return address.port;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ConnectorError("upstream_incompatible", "T3 Connect returned invalid JSON.");
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ConnectorError("connect_unavailable", "T3 Connect could not be reached safely.");
  }
}

function connectErrorForStatus(status: number): ConnectorError {
  if (status === 401) return new ConnectorError("connect_auth_expired", "T3 Connect authentication expired; authenticate again.");
  if (status === 403) return new ConnectorError("connect_permission_denied", "T3 Connect denied this operation.");
  if (status === 404) return new ConnectorError("connect_environment_not_found", "The selected Connect environment is unavailable.");
  if (status >= 500) return new ConnectorError("connect_unavailable", "T3 Connect is temporarily unavailable.");
  return new ConnectorError("connect_unavailable", "T3 Connect rejected the request.");
}

function parseConnectEnvironment(value: unknown): ConnectEnvironment {
  if (!value || typeof value !== "object") throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid environment.");
  const environment = value as Record<string, unknown>;
  const endpoint = environment.endpoint;
  if (
    typeof environment.environmentId !== "string" ||
    !environment.environmentId.trim() ||
    typeof environment.label !== "string" ||
    !environment.label.trim() ||
    typeof environment.linkedAt !== "string" ||
    !endpoint ||
    typeof endpoint !== "object"
  ) {
    throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid environment.");
  }
  const endpointRecord = endpoint as Record<string, unknown>;
  if (
    typeof endpointRecord.httpBaseUrl !== "string" ||
    typeof endpointRecord.wsBaseUrl !== "string" ||
    !["manual", "cloudflare_tunnel", "t3_relay"].includes(String(endpointRecord.providerKind))
  ) {
    throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid environment endpoint.");
  }
  const httpBaseUrl = normalizedUrl(endpointRecord.httpBaseUrl, true);
  return {
    id: environment.environmentId.trim(),
    label: environment.label.trim(),
    endpoint: httpBaseUrl,
    linkedAt: environment.linkedAt,
  };
}

export class ConnectManager {
  private pending: PendingAuthorization | undefined;
  private last: PublicConnectAuth = { status: "signed_out" };

  constructor(private readonly store: ConnectStore) {}

  async authenticate(action: "start" | "status" | "cancel" = "start"): Promise<PublicConnectAuth> {
    if (action === "status") return this.status();
    if (action === "cancel") return this.cancel();

    if (await this.store.read()) return { status: "authenticated" };
    if (this.pending) return publicAuth("pending", this.pending);

    const settings = config();
    const verifier = randomBase64Url(32);
    const state = randomBase64Url(16);
    const key = generateDpopKey();
    const server = createHttpServer((request, response) => {
      void this.handleCallback(request, response);
    });
    const port = await listen(server);
    const expiresAt = new Date(Date.now() + AUTH_TIMEOUT_MS).toISOString();
    const authorizationUrl = new URL("/connect", settings.hostedAppUrl);
    authorizationUrl.hash = new URLSearchParams([
      ["state", state],
      ["challenge", oauthChallenge(verifier)],
      ["port", String(port)],
    ]).toString();
    const pending: PendingAuthorization = {
      state,
      verifier,
      authorizationUrl: authorizationUrl.toString(),
      expiresAt,
      key,
      server,
      timer: setTimeout(() => {
        void this.expirePending();
      }, AUTH_TIMEOUT_MS),
    };
    this.pending = pending;
    this.last = publicAuth("pending", pending);
    return this.last;
  }

  async status(): Promise<PublicConnectAuth> {
    if (this.pending) return publicAuth("pending", this.pending);
    if (await this.store.read()) return { status: "authenticated" };
    return this.last;
  }

  async cancel(): Promise<PublicConnectAuth> {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      await closeServer(this.pending.server);
      this.pending = undefined;
    }
    this.last = publicAuth("cancelled", undefined, {
      code: "connect_auth_cancelled",
      message: "T3 Connect authorization was cancelled.",
    });
    return this.last;
  }

  async signOut(): Promise<{ readonly signedOut: boolean }> {
    await this.cancel();
    const existing = await this.store.read();
    if (existing) await this.store.clear();
    this.last = { status: "signed_out" };
    return { signedOut: existing !== null };
  }

  async listEnvironments(): Promise<readonly ConnectEnvironment[]> {
    const settings = config();
    const auth = await this.authToken();
    const response = await fetchWithTimeout(`${settings.relayUrl}v1/environments`, {
      method: "GET",
      headers: { authorization: `Bearer ${auth.accessToken}` },
    });
    if (!response.ok) throw connectErrorForStatus(response.status);
    const value = await responseJson(response);
    if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).environments)) {
      throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid environment list.");
    }
    return (value as { environments: unknown[] }).environments.map(parseConnectEnvironment);
  }

  async connectEnvironment(environmentId: string): Promise<{
    readonly environment: ConnectEnvironment;
    readonly pairing: PairingResult;
    readonly accountId?: string;
    readonly credential: string;
  }> {
    const selectedId = environmentId.trim();
    if (!selectedId) throw new ConnectorError("invalid_input", "environmentId is required.");
    const settings = config();
    const auth = await this.authToken();
    const environments = await this.listEnvironments();
    const environment = environments.find((entry) => entry.id === selectedId);
    if (!environment) throw new ConnectorError("connect_environment_not_found", "The selected Connect environment is unavailable.");

    const relayToken = await this.relayAccessToken(settings, auth);
    const key = auth.dpopPrivateJwk;
    const connectUrl = `${settings.relayUrl}v1/environments/${encodeURIComponent(selectedId)}/connect`;
    const connectResponse = await fetchWithTimeout(connectUrl, {
      method: "POST",
      headers: {
        authorization: `DPoP ${relayToken}`,
        dpop: createDpopProof({ key, method: "POST", url: connectUrl, accessToken: relayToken }),
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientProofKeyThumbprint: dpopThumbprint(key) }),
    });
    if (!connectResponse.ok) throw connectErrorForStatus(connectResponse.status);
    const value = await responseJson(connectResponse);
    if (!value || typeof value !== "object") {
      throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid environment credential.");
    }
    const result = value as Record<string, unknown>;
    if (
      result.environmentId !== selectedId ||
      typeof result.credential !== "string" ||
      !result.credential.trim() ||
      typeof result.endpoint !== "object" ||
      result.endpoint === null ||
      typeof (result.endpoint as Record<string, unknown>).httpBaseUrl !== "string"
    ) {
      throw new ConnectorError("connect_identity_mismatch", "T3 Connect did not prove the selected environment identity.");
    }
    const endpoint = parseEndpoint(
      (result.endpoint as Record<string, unknown>).httpBaseUrl as string,
      result.credential,
    );
    const pairing = await pairConnectEnvironment(endpoint, key);
    if (pairing.descriptor.environmentId !== selectedId) {
      throw new ConnectorError("connect_identity_mismatch", "The environment returned a different identity than Connect selected.");
    }
    return {
      environment,
      pairing,
      credential: result.credential,
      ...(auth.accountId ? { accountId: auth.accountId } : {}),
    };
  }

  private async authToken(): Promise<ConnectAuth> {
    const existing = await this.store.read();
    if (!existing) throw new ConnectorError("connect_auth_expired", "Authenticate with T3 Connect before using Connect environments.");
    if (Date.parse(existing.expiresAt) > Date.now() + AUTH_REFRESH_WINDOW_MS) return existing;
    if (!existing.refreshToken) throw new ConnectorError("connect_auth_expired", "T3 Connect authentication expired; authenticate again.");

    const settings = config();
    const response = await fetchWithTimeout(settings.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: existing.refreshToken,
        client_id: settings.clientId,
      }),
    });
    if (!response.ok) throw new ConnectorError("connect_auth_expired", "T3 Connect authentication expired; authenticate again.");
    const token = await this.readTokenResponse(response);
    const refreshed: ConnectAuth = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken || existing.refreshToken,
      expiresAt: token.expiresAt,
      dpopPrivateJwk: existing.dpopPrivateJwk,
      ...(existing.accountId || token.accountId
        ? { accountId: token.accountId ?? existing.accountId }
        : {}),
    };
    await this.store.replace(refreshed);
    return refreshed;
  }

  private async relayAccessToken(settings: ConnectConfig, auth: ConnectAuth): Promise<string> {
    const url = `${settings.relayUrl}v1/client/dpop-token`;
    const proof = createDpopProof({ key: auth.dpopPrivateJwk, method: "POST", url });
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { dpop: proof, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        subject_token: auth.accessToken,
        subject_token_type: RELAY_JWT_SUBJECT_TOKEN_TYPE,
        requested_token_type: RELAY_ACCESS_TOKEN_TYPE,
        resource: settings.relayUrl,
        scope: "environment:connect",
        client_id: settings.relayClientId,
      }),
    });
    if (!response.ok) throw connectErrorForStatus(response.status);
    const value = await responseJson(response);
    const relay = value as Record<string, unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      typeof relay.access_token !== "string" ||
      relay.token_type !== "DPoP" ||
      typeof relay.expires_in !== "number" ||
      typeof relay.scope !== "string" ||
      !relay.scope.split(/\s+/).includes("environment:connect")
    ) {
      throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid relay session.");
    }
    return relay.access_token as string;
  }

  private async readTokenResponse(response: Response): Promise<{
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly expiresAt: string;
    readonly accountId?: string;
  }> {
    const value = await responseJson(response);
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as Record<string, unknown>).access_token !== "string" ||
      typeof (value as Record<string, unknown>).expires_in !== "number"
    ) {
      throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid authentication response.");
    }
    const token = value as Record<string, unknown>;
    const accessToken = token.access_token as string;
    const expiresIn = token.expires_in;
    if (typeof expiresIn !== "number" || expiresIn <= 0) {
      throw new ConnectorError("upstream_incompatible", "T3 Connect returned an invalid authentication response.");
    }
    const accountId = decodeJwtSubject(typeof token.id_token === "string" ? token.id_token : accessToken);
    return {
      accessToken,
      refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : "",
      expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
      ...(accountId ? { accountId } : {}),
    };
  }

  private async handleCallback(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      response.writeHead(410, { "content-type": "text/plain" });
      response.end("T3 Connect authorization is no longer pending.");
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (url.searchParams.get("state") !== pending.state) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("Invalid T3 Connect authorization callback.");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      await this.finishPending("failed", "connect_auth_failed", "T3 Connect authorization was denied.");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("T3 Connect authorization was not completed. You may close this window.");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("Invalid T3 Connect authorization callback.");
      return;
    }
    try {
      const settings = config();
      const tokenResponse = await fetchWithTimeout(settings.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `http://127.0.0.1:${(pending.server.address() as import("node:net").AddressInfo).port}/callback`,
          client_id: settings.clientId,
          code_verifier: pending.verifier,
        }),
      });
      if (!tokenResponse.ok) throw safeAuthFailure("connect_auth_failed", "T3 Connect authorization failed.");
      const token = await this.readTokenResponse(tokenResponse);
      await this.finishPendingWithToken(token, pending.key);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("T3 Connect authorization completed. You may close this window.");
    } catch (callbackError) {
      const failureCode =
        callbackError instanceof ConnectorError && callbackError.code === "connect_auth_expired"
          ? "connect_auth_expired"
          : "connect_auth_failed";
      if (this.pending) {
        await this.finishPending("failed", failureCode, "T3 Connect authorization failed.");
      } else {
        this.last = publicAuth("failed", undefined, {
          code: failureCode,
          message: "T3 Connect authorization failed.",
        });
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("T3 Connect authorization failed. You may close this window.");
    }
  }

  private async finishPendingWithToken(
    token: { readonly accessToken: string; readonly refreshToken: string; readonly expiresAt: string; readonly accountId?: string },
    key: DpopPrivateJwk,
  ): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      throw safeAuthFailure("connect_auth_expired", "T3 Connect authorization is no longer pending.");
    }
    clearTimeout(pending.timer);
    if (pending.server.listening) pending.server.close(() => undefined);
    this.pending = undefined;
    const existing = await this.store.read();
    if (existing && token.accountId && existing.accountId && token.accountId !== existing.accountId) {
      this.last = publicAuth("failed", undefined, {
        code: "connect_account_conflict",
        message: "A different T3 Connect account is already active; sign out before switching accounts.",
      });
      return;
    }
    await this.store.replace({
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      dpopPrivateJwk: key,
      ...(token.accountId ? { accountId: token.accountId } : {}),
    });
    this.last = { status: "authenticated" };
  }

  private async finishPending(
    status: "failed" | "cancelled",
    code: "connect_auth_failed" | "connect_auth_expired" | "connect_auth_cancelled",
    message: string,
  ): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.server.listening) pending.server.close(() => undefined);
    this.pending = undefined;
    this.last = publicAuth(status, undefined, { code, message });
  }

  private async expirePending(): Promise<void> {
    await this.finishPending("failed", "connect_auth_expired", "T3 Connect authorization expired; authenticate again.");
  }
}
