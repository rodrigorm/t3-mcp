import { ConnectorError } from "./errors.js";
import { endpointPath, publicEndpoint, type ValidatedEndpoint } from "./url.js";
import {
  REQUIRED_SCOPES,
  SUPPORTED_ORCHESTRATION_PROTOCOL_VERSION,
  type EnvironmentDescriptor,
  type PairingResult,
} from "./types.js";

const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseDescriptor(value: unknown): EnvironmentDescriptor {
  if (!isRecord(value)) {
    throw new ConnectorError("upstream_incompatible", "The environment descriptor is invalid.");
  }

  const platform = value.platform;
  const capabilities = value.capabilities;
  const protocolVersion = value.orchestrationProtocolVersion ?? SUPPORTED_ORCHESTRATION_PROTOCOL_VERSION;
  if (
    !requiredString(value.environmentId) ||
    !requiredString(value.label) ||
    !requiredString(value.serverVersion) ||
    !isRecord(platform) ||
    !requiredString(platform.os) ||
    !requiredString(platform.arch) ||
    !isRecord(capabilities) ||
    !Number.isInteger(protocolVersion) ||
    protocolVersion !== SUPPORTED_ORCHESTRATION_PROTOCOL_VERSION
  ) {
    throw new ConnectorError(
      "upstream_incompatible",
      "The environment does not advertise the supported T3 contract.",
    );
  }

  return {
    environmentId: value.environmentId.trim(),
    label: value.label.trim(),
    serverVersion: value.serverVersion.trim(),
    orchestrationProtocolVersion: protocolVersion,
    platform: { os: platform.os.trim(), arch: platform.arch.trim() },
    capabilities,
  };
}

async function request(
  url: URL,
  init: RequestInit,
  errorCode: "descriptor" | "pairing" | "session",
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ConnectorError(
      "transport_error",
      errorCode === "pairing"
        ? "The environment could not complete pairing."
        : "The environment could not be reached safely.",
    );
  }

  if (!response.ok) {
    if (errorCode === "pairing" && (response.status === 401 || response.status === 400)) {
      throw new ConnectorError("pairing_rejected", "The environment rejected the pairing grant.");
    }
    if (response.status === 403) {
      throw new ConnectorError("permission_denied", "The environment denied this operation.");
    }
    throw new ConnectorError(
      errorCode === "descriptor" ? "upstream_incompatible" : "transport_error",
      "The environment returned an unsupported response.",
    );
  }
  return response;
}

async function json(response: Response, code: ConnectorErrorCodeForResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ConnectorError(code, "The environment returned invalid JSON.");
  }
}

type ConnectorErrorCodeForResponse = "upstream_incompatible" | "pairing_rejected";

function parseSession(value: unknown, accessTokenExpiresAt: string): string {
  if (!isRecord(value) || value.authenticated !== true) {
    throw new ConnectorError("pairing_rejected", "The environment did not establish a session.");
  }
  const scopes = value.scopes;
  if (
    !Array.isArray(scopes) ||
    !REQUIRED_SCOPES.every((scope) => scopes.includes(scope)) ||
    value.sessionMethod !== "bearer-access-token"
  ) {
    throw new ConnectorError(
      "upstream_incompatible",
      "The environment session does not provide the required scopes.",
    );
  }
  if (value.expiresAt === undefined) return accessTokenExpiresAt;
  if (!requiredString(value.expiresAt) || Number.isNaN(Date.parse(value.expiresAt))) {
    throw new ConnectorError("upstream_incompatible", "The environment session expiry is invalid.");
  }
  return new Date(
    Math.min(Date.parse(value.expiresAt), Date.parse(accessTokenExpiresAt)),
  ).toISOString();
}

export async function pairEnvironment(
  endpoint: ValidatedEndpoint,
  clientLabel = "t3-mcp",
): Promise<PairingResult> {
  const descriptorResponse = await request(
    endpointPath(endpoint.baseUrl, "/.well-known/t3/environment"),
    { method: "GET" },
    "descriptor",
  );
  const descriptor = parseDescriptor(
    await json(descriptorResponse, "upstream_incompatible"),
  );

  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: endpoint.grant,
    subject_token_type: ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
    scope: REQUIRED_SCOPES.join(" "),
    client_label: clientLabel,
    client_device_type: "bot",
    client_os: process.platform,
  });
  const tokenResponse = await request(
    endpointPath(endpoint.baseUrl, "/oauth/token"),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    "pairing",
  );
  const token = await json(tokenResponse, "pairing_rejected");
  if (
    !isRecord(token) ||
    !requiredString(token.access_token) ||
    token.token_type !== "Bearer" ||
    token.issued_token_type !== ACCESS_TOKEN_TYPE ||
    typeof token.expires_in !== "number" ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0 ||
    !requiredString(token.scope)
  ) {
    throw new ConnectorError("upstream_incompatible", "The environment token response is invalid.");
  }
  const grantedScopes = token.scope.trim().split(/\s+/);
  if (!REQUIRED_SCOPES.every((scope) => grantedScopes.includes(scope))) {
    throw new ConnectorError(
      "permission_denied",
      "The environment did not grant the required orchestration scopes.",
    );
  }
  const accessTokenExpiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();

  const sessionResponse = await request(
    endpointPath(endpoint.baseUrl, "/api/auth/session"),
    { method: "GET", headers: { authorization: `Bearer ${token.access_token}` } },
    "session",
  );
  const session = await json(sessionResponse, "upstream_incompatible");
  const sessionExpiresAt = parseSession(session, accessTokenExpiresAt);

  return {
    descriptor,
    accessToken: token.access_token,
    sessionExpiresAt,
    scopes: REQUIRED_SCOPES,
    tokenType: "Bearer",
  };
}

export { publicEndpoint };
