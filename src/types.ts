export const SUPPORTED_ORCHESTRATION_PROTOCOL_VERSION = 1;
export const REQUIRED_SCOPES = ["orchestration:read", "orchestration:operate"] as const;
export const DEFAULT_THREAD_HISTORY_TURN_LIMIT = 20;
export const MAX_THREAD_HISTORY_TURN_LIMIT = 100;
export const MAX_START_TURN_PROMPT_LENGTH = 120_000;

export interface DpopPublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

export interface DpopPrivateJwk extends DpopPublicJwk {
  readonly d: string;
}

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
  readonly tokenType: "Bearer" | "DPoP";
  readonly dpopPrivateJwk?: DpopPrivateJwk;
  readonly accessSource?: "direct" | "connect";
  readonly directAccess?: EnvironmentAccess;
  readonly connectAccess?: EnvironmentAccess;
  readonly connectAccountId?: string;
}

export interface EnvironmentAccess {
  readonly endpoint: string;
  readonly serverVersion: string;
  readonly orchestrationProtocolVersion: number;
  readonly scopes: readonly string[];
  readonly sessionExpiresAt: string;
  readonly pairedAt: string;
  readonly accessToken: string;
  readonly tokenType: "Bearer" | "DPoP";
  readonly dpopPrivateJwk?: DpopPrivateJwk;
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
  readonly source?: "direct" | "connect";
  readonly connectAttached?: boolean;
}

export interface PairingResult {
  readonly descriptor: EnvironmentDescriptor;
  readonly accessToken: string;
  readonly sessionExpiresAt: string;
  readonly scopes: readonly string[];
  readonly tokenType: "Bearer" | "DPoP";
  readonly dpopPrivateJwk?: DpopPrivateJwk;
}

export interface PublicProject {
  readonly id: string;
  readonly name: string;
}

export interface ModelSelectionOption {
  readonly id: string;
  readonly value: string | boolean;
}

export interface ModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: readonly ModelSelectionOption[];
}

export type PublicStartTurnOutcome = "acknowledged" | "partial" | "unknown";

export interface PublicStartTurn {
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly outcome: PublicStartTurnOutcome;
  readonly createCommandId: string;
  readonly turnCommandId?: string;
  readonly createSequence?: number;
  readonly turnSequence?: number;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export type PublicContinueTurnOutcome = "acknowledged" | "unknown";

export interface PublicContinueTurn {
  readonly environmentId: string;
  readonly threadId: string;
  readonly outcome: PublicContinueTurnOutcome;
  readonly turnCommandId: string;
  readonly messageId: string;
  readonly turnSequence?: number;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export type PublicThreadStatus =
  | "idle"
  | "starting"
  | "running"
  | "completed"
  | "interrupted"
  | "error"
  | "approval_required"
  | "input_required"
  | "unknown";

export interface PublicThreadMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly turnId: string | null;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicThreadActivity {
  readonly id: string;
  readonly tone: string;
  readonly kind: string;
  readonly summary: string;
  readonly turnId: string | null;
  readonly createdAt: string;
}

export interface PublicThreadHistory {
  readonly turnLimit: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly truncated: boolean;
  readonly snapshotSequence: number;
  readonly threadSequence?: number;
}

export interface PublicThread {
  readonly environmentId: string;
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: PublicThreadStatus;
  readonly upstreamState?: string;
  readonly messages: readonly PublicThreadMessage[];
  readonly activities: readonly PublicThreadActivity[];
  readonly history: PublicThreadHistory;
}
