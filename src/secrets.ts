import { ConnectorError } from "./errors.js";
import type { PairedEnvironment } from "./types.js";

export function environmentSecrets(environment: PairedEnvironment): readonly string[] {
  return [environment, environment.directAccess, environment.connectAccess]
    .flatMap((access) => [access?.accessToken, access?.dpopPrivateJwk?.d])
    .filter((secret): secret is string => !!secret);
}

export function safePayload<T>(value: T, secrets: readonly string[]): T {
  const payload = JSON.stringify(value);
  const reflected = secrets.filter(Boolean).some((secret) =>
    [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]
      .some((representation) => payload.includes(representation)));
  if (reflected) {
    throw new ConnectorError("upstream_incompatible", "The upstream returned unsafe credential-bearing metadata.");
  }
  return value;
}
