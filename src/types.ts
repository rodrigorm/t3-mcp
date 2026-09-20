export const SUPPORTED_ORCHESTRATION_PROTOCOL_VERSION = 1;
export const REQUIRED_SCOPES = ["orchestration:read", "orchestration:operate"] as const;

export interface EnvironmentDescriptor {
  readonly environmentId: string;
  readonly label: string;
  readonly serverVersion: string;
  readonly orchestrationProtocolVersion: number;
  readonly platform: {
    readonly os: string;
    readonly arch: string;
  };
  readonly capabilities: Record<string, unknown>;
}

export interface PairedEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly endpoint: string;
  readonly serverVersion: string;
  readonly orchestrationProtocolVersion: number;
  readonly scopes: readonly string[];
  readonly sessionExpiresAt: string;
  readonly pairedAt: string;
  readonly accessToken: string;
  readonly tokenType: "Bearer";
}

export interface PublicEnvironment {
  readonly id: string;
  readonly label: string;
  readonly endpoint: string;
  readonly serverVersion: string;
  readonly orchestrationProtocolVersion: number;
  readonly scopes: readonly string[];
  readonly sessionExpiresAt: string;
  readonly pairedAt: string;
}

export interface PairingResult {
  readonly descriptor: EnvironmentDescriptor;
  readonly accessToken: string;
  readonly sessionExpiresAt: string;
  readonly scopes: readonly string[];
  readonly tokenType: "Bearer";
}
