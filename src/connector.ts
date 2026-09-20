import { ConnectorError } from "./errors.js";
import { EnvironmentStore } from "./storage.js";
import {
  getThread as getUpstreamThread,
  listProjects as listUpstreamProjects,
  pairEnvironment,
  publicEndpoint,
} from "./upstream.js";
import { parseEndpoint } from "./url.js";
import {
  DEFAULT_THREAD_HISTORY_TURN_LIMIT,
  MAX_THREAD_HISTORY_TURN_LIMIT,
  type PairedEnvironment,
  type PublicEnvironment,
  type PublicProject,
  type PublicThread,
} from "./types.js";

export interface AddEnvironmentInput {
  readonly pairingUrl?: string;
  readonly endpoint?: string;
  readonly grant?: string;
  readonly label?: string;
  readonly environmentId?: string;
}

export interface GetThreadInput {
  readonly environmentId: string;
  readonly threadId: string;
  readonly turnLimit?: number;
  readonly beforeCursor?: string;
}

function publicEnvironment(environment: PairedEnvironment): PublicEnvironment {
  return {
    id: environment.environmentId,
    label: environment.label,
    endpoint: environment.endpoint,
    serverVersion: environment.serverVersion,
    orchestrationProtocolVersion: environment.orchestrationProtocolVersion,
    scopes: environment.scopes,
    sessionExpiresAt: environment.sessionExpiresAt,
    pairedAt: environment.pairedAt,
  };
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  return secrets.filter(Boolean).reduce((safe, secret) => safe.split(secret).join("[redacted]"), value);
}

function cleanLabel(label: string | undefined, fallback: string, secrets: readonly string[]): string {
  const value = redactSecrets(label?.trim() || fallback.trim(), secrets);
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ConnectorError("invalid_input", "Label must be a printable string of 200 characters or fewer.");
  }
  return value;
}

export class EnvironmentConnector {
  constructor(private readonly store: EnvironmentStore) {}

  private async selectEnvironment(environmentId: string): Promise<PairedEnvironment> {
    if (typeof environmentId !== "string" || !environmentId.trim()) {
      throw new ConnectorError("invalid_input", "environmentId is required.");
    }
    const environments = await this.store.read();
    const environment = environments.get(environmentId.trim());
    if (!environment) {
      throw new ConnectorError("environment_not_found", "The selected environment is not saved.");
    }
    const expiresAt = Date.parse(environment.sessionExpiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      throw new ConnectorError(
        "session_expired",
        "The saved environment session expired or was revoked; pair the environment again.",
      );
    }
    return environment;
  }

  async addEnvironment(input: AddEnvironmentInput): Promise<PublicEnvironment> {
    if (input.pairingUrl && input.endpoint) {
      throw new ConnectorError("invalid_input", "Provide pairingUrl or endpoint, not both.");
    }
    const inputUrl = input.pairingUrl ?? input.endpoint;
    if (!inputUrl) {
      throw new ConnectorError("invalid_input", "A pairingUrl or endpoint is required.");
    }
    if (input.environmentId !== undefined && !input.environmentId.trim()) {
      throw new ConnectorError("invalid_input", "environmentId must not be empty.");
    }

    const environments = await this.store.read();
    const targetId = input.environmentId?.trim();
    if (targetId && !environments.has(targetId)) {
      throw new ConnectorError("environment_not_found", "The environment to re-pair is not saved.");
    }

    const endpoint = parseEndpoint(inputUrl, input.grant);
    const paired = await pairEnvironment(endpoint);
    const environmentId = paired.descriptor.environmentId;
    const secrets = [endpoint.grant, paired.accessToken];
    const safeEndpoint = publicEndpoint(endpoint.baseUrl);
    if (secrets.some((secret) => safeEndpoint.includes(secret) || environmentId === secret)) {
      throw new ConnectorError("upstream_incompatible", "The environment metadata is unsafe to save.");
    }
    if (targetId && targetId !== environmentId) {
      throw new ConnectorError(
        "environment_conflict",
        "The paired environment identifier does not match the requested identifier.",
      );
    }
    if (!targetId && environments.has(environmentId)) {
      throw new ConnectorError(
        "environment_exists",
        "An environment with this identifier is already saved; re-pair it explicitly.",
      );
    }

    const registration: PairedEnvironment = {
      environmentId,
      label: cleanLabel(input.label, paired.descriptor.label, secrets),
      endpoint: safeEndpoint,
      serverVersion: paired.descriptor.serverVersion,
      orchestrationProtocolVersion: paired.descriptor.orchestrationProtocolVersion,
      scopes: [...paired.scopes],
      sessionExpiresAt: paired.sessionExpiresAt,
      pairedAt: new Date().toISOString(),
      accessToken: paired.accessToken,
      tokenType: paired.tokenType,
    };
    environments.set(environmentId, registration);
    await this.store.replace(environments);
    return publicEnvironment(registration);
  }

  async listEnvironments(): Promise<readonly PublicEnvironment[]> {
    const environments = await this.store.read();
    return [...environments.values()]
      .sort((left, right) => left.label.localeCompare(right.label) || left.environmentId.localeCompare(right.environmentId))
      .map(publicEnvironment);
  }

  async listProjects(environmentId: string): Promise<readonly PublicProject[]> {
    return listUpstreamProjects(await this.selectEnvironment(environmentId));
  }

  async getThread(input: GetThreadInput): Promise<PublicThread> {
    const environment = await this.selectEnvironment(input.environmentId);
    const threadId = input.threadId.trim();
    if (!threadId) {
      throw new ConnectorError("invalid_input", "threadId is required.");
    }
    const turnLimit = input.turnLimit ?? DEFAULT_THREAD_HISTORY_TURN_LIMIT;
    if (
      !Number.isInteger(turnLimit) ||
      turnLimit < 1 ||
      turnLimit > MAX_THREAD_HISTORY_TURN_LIMIT
    ) {
      throw new ConnectorError(
        "invalid_input",
        `turnLimit must be an integer from 1 to ${MAX_THREAD_HISTORY_TURN_LIMIT}.`,
      );
    }
    const beforeCursor = input.beforeCursor?.trim();
    if (input.beforeCursor !== undefined && !beforeCursor) {
      throw new ConnectorError("invalid_input", "beforeCursor must not be empty.");
    }
    return getUpstreamThread(environment, threadId, turnLimit, beforeCursor);
  }
}
