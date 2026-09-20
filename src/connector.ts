import { ConnectorError } from "./errors.js";
import { EnvironmentStore } from "./storage.js";
import { pairEnvironment, publicEndpoint } from "./upstream.js";
import { parseEndpoint } from "./url.js";
import type { PairedEnvironment, PublicEnvironment } from "./types.js";

export interface AddEnvironmentInput {
  readonly pairingUrl?: string;
  readonly endpoint?: string;
  readonly grant?: string;
  readonly label?: string;
  readonly environmentId?: string;
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
}
