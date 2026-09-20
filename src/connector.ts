import { randomUUID } from "node:crypto";

import { ConnectorError } from "./errors.js";
import { ConnectManager, type ConnectEnvironment, type PublicConnectAuth } from "./connect.js";
import { ConnectStore, EnvironmentStore } from "./storage.js";
import {
  dispatchCommand,
  getProjectForStart,
  getThread as getUpstreamThread,
  listProjects as listUpstreamProjects,
  pairEnvironment,
  publicEndpoint,
} from "./upstream.js";
import { parseEndpoint } from "./url.js";
import {
  DEFAULT_THREAD_HISTORY_TURN_LIMIT,
  MAX_START_TURN_PROMPT_LENGTH,
  MAX_THREAD_HISTORY_TURN_LIMIT,
  type ModelSelection,
  type EnvironmentAccess,
  type PairedEnvironment,
  type PublicEnvironment,
  type PublicContinueTurn,
  type PublicProject,
  type PublicStartTurn,
  type PublicThread,
  type PairingResult,
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

export interface StartTurnInput {
  readonly environmentId: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly modelSelection?: ModelSelection;
}

export interface ContinueTurnInput {
  readonly environmentId: string;
  readonly threadId: string;
  readonly prompt: string;
}

export interface ConnectAuthInput {
  readonly action?: "start" | "status" | "cancel";
}

export interface RegisterConnectEnvironmentInput {
  readonly environmentId: string;
  readonly label?: string;
}

export interface AttachConnectEnvironmentInput {
  readonly environmentId: string;
  readonly targetEnvironmentId: string;
  readonly label?: string;
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
    ...(environment.accessSource === "connect" ? { source: "connect" as const } : {}),
    ...(environment.connectAccess ? { connectAttached: true } : {}),
  };
}

function accessFromPairing(pair: {
  readonly descriptor: PairingResult["descriptor"];
  readonly accessToken: PairingResult["accessToken"];
  readonly sessionExpiresAt: PairingResult["sessionExpiresAt"];
  readonly scopes: PairingResult["scopes"];
  readonly tokenType: PairingResult["tokenType"];
  readonly dpopPrivateJwk?: PairingResult["dpopPrivateJwk"];
}, endpoint: string): EnvironmentAccess {
  return {
    endpoint,
    serverVersion: pair.descriptor.serverVersion,
    orchestrationProtocolVersion: pair.descriptor.orchestrationProtocolVersion,
    scopes: [...pair.scopes],
    sessionExpiresAt: pair.sessionExpiresAt,
    pairedAt: new Date().toISOString(),
    accessToken: pair.accessToken,
    tokenType: pair.tokenType,
    ...(pair.dpopPrivateJwk ? { dpopPrivateJwk: pair.dpopPrivateJwk } : {}),
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

function cleanModelSelection(value: ModelSelection | undefined): ModelSelection | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value.instanceId !== "string" ||
    !value.instanceId.trim() ||
    typeof value.model !== "string" ||
    !value.model.trim()
  ) {
    throw new ConnectorError("invalid_input", "modelSelection must include instanceId and model.");
  }
  if (
    value.options !== undefined &&
    (!Array.isArray(value.options) ||
      value.options.some(
        (option) =>
          !option ||
          typeof option.id !== "string" ||
          !option.id.trim() ||
          (typeof option.value !== "boolean" &&
            (typeof option.value !== "string" || !option.value.trim())),
      ))
  ) {
    throw new ConnectorError("invalid_input", "modelSelection options are invalid.");
  }
  return {
    instanceId: value.instanceId.trim(),
    model: value.model.trim(),
    ...(value.options === undefined
      ? {}
      : {
          options: value.options.map((option) => ({
            id: option.id.trim(),
            value: typeof option.value === "string" ? option.value.trim() : option.value,
          })),
        }),
  };
}

function threadTurnStartCommand(
  commandId: string,
  threadId: string,
  prompt: string,
  messageId = randomUUID(),
) {
  return {
    type: "thread.turn.start",
    commandId,
    threadId,
    message: {
      messageId,
      role: "user",
      text: prompt,
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  };
}

function safeError(error: unknown): ConnectorError {
  return error instanceof ConnectorError
    ? error
    : new ConnectorError("internal_error", "The connector could not complete the request.");
}

export class EnvironmentConnector {
  private readonly connect: ConnectManager;

  constructor(
    private readonly store: EnvironmentStore,
    connectStore = new ConnectStore(store.directory),
  ) {
    this.connect = new ConnectManager(connectStore);
  }

  private async selectEnvironment(environmentId: string): Promise<PairedEnvironment> {
    if (typeof environmentId !== "string" || !environmentId.trim()) {
      throw new ConnectorError("invalid_input", "environmentId is required.");
    }
    const environments = await this.store.read();
    const environment = environments.get(environmentId.trim());
    if (!environment) {
      throw new ConnectorError("environment_not_found", "The selected environment is not saved.");
    }
    const candidates: PairedEnvironment[] = [environment];
    if (environment.accessSource === "connect" && environment.directAccess) {
      candidates.push({ ...environment, ...environment.directAccess, accessSource: "direct" });
    } else if (environment.accessSource === "direct" && environment.connectAccess) {
      candidates.push({ ...environment, ...environment.connectAccess, accessSource: "connect" });
    }
    for (const candidate of candidates) {
      const expiresAt = Date.parse(candidate.sessionExpiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) return candidate;
    }
    throw new ConnectorError(
      "session_expired",
      "The saved environment session expired or was revoked; pair the environment again.",
    );
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

    const endpoint = parseEndpoint(inputUrl, input.grant, input.pairingUrl !== undefined);
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

    const directAccess = accessFromPairing(paired, safeEndpoint);
    const registration: PairedEnvironment = {
      environmentId,
      label: cleanLabel(input.label, paired.descriptor.label, secrets),
      ...directAccess,
      accessSource: "direct",
      directAccess,
      ...(environments.get(environmentId)?.connectAccess
        ? { connectAccess: environments.get(environmentId)?.connectAccess }
        : {}),
      ...(environments.get(environmentId)?.connectAccountId
        ? { connectAccountId: environments.get(environmentId)?.connectAccountId }
        : {}),
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

  async connectAuth(input: ConnectAuthInput = {}): Promise<PublicConnectAuth> {
    return this.connect.authenticate(input.action);
  }

  async listConnectEnvironments(): Promise<readonly ConnectEnvironment[]> {
    return this.connect.listEnvironments();
  }

  async registerConnectEnvironment(
    input: RegisterConnectEnvironmentInput,
  ): Promise<PublicEnvironment> {
    const environmentId = typeof input?.environmentId === "string" ? input.environmentId.trim() : "";
    if (!environmentId) throw new ConnectorError("invalid_input", "environmentId is required.");
    const environments = await this.store.read();
    if (environments.has(environmentId)) {
      throw new ConnectorError(
        "environment_exists",
        "An environment with this identifier is already saved; attach Connect access explicitly.",
      );
    }
    const connected = await this.connect.connectEnvironment(environmentId);
    const endpoint = connected.environment.endpoint;
    const access = accessFromPairing(connected.pairing, endpoint);
    const registration: PairedEnvironment = {
      environmentId,
      label: cleanLabel(input.label, connected.environment.label, [connected.credential, connected.pairing.accessToken]),
      ...access,
      accessSource: "connect",
      connectAccess: access,
      ...(connected.accountId ? { connectAccountId: connected.accountId } : {}),
    };
    environments.set(environmentId, registration);
    await this.store.replace(environments);
    return publicEnvironment(registration);
  }

  async attachConnectEnvironment(
    input: AttachConnectEnvironmentInput,
  ): Promise<PublicEnvironment> {
    const environmentId = typeof input?.environmentId === "string" ? input.environmentId.trim() : "";
    const targetEnvironmentId =
      typeof input?.targetEnvironmentId === "string" ? input.targetEnvironmentId.trim() : "";
    if (!environmentId || !targetEnvironmentId) {
      throw new ConnectorError("invalid_input", "environmentId and targetEnvironmentId are required.");
    }
    if (environmentId !== targetEnvironmentId) {
      throw new ConnectorError(
        "connect_identity_mismatch",
        "Connect access can only attach when the upstream environment identifier matches the saved registration.",
      );
    }
    const environments = await this.store.read();
    const existing = environments.get(targetEnvironmentId);
    if (!existing) throw new ConnectorError("environment_not_found", "The selected environment is not saved.");
    const connected = await this.connect.connectEnvironment(environmentId);
    if (connected.pairing.descriptor.environmentId !== targetEnvironmentId) {
      throw new ConnectorError("connect_identity_mismatch", "Connect returned a different environment identity.");
    }
    const endpoint = connected.environment.endpoint;
    const connectAccess = accessFromPairing(connected.pairing, endpoint);
    const directAccess = existing.directAccess ??
      (existing.accessSource === "direct" ? {
        endpoint: existing.endpoint,
        serverVersion: existing.serverVersion,
        orchestrationProtocolVersion: existing.orchestrationProtocolVersion,
        scopes: existing.scopes,
        sessionExpiresAt: existing.sessionExpiresAt,
        pairedAt: existing.pairedAt,
        accessToken: existing.accessToken,
        tokenType: existing.tokenType,
        ...(existing.dpopPrivateJwk ? { dpopPrivateJwk: existing.dpopPrivateJwk } : {}),
      } satisfies EnvironmentAccess : undefined);
    const registration: PairedEnvironment = {
      ...existing,
      label: cleanLabel(input.label, existing.label, [connected.credential, connected.pairing.accessToken]),
      ...connectAccess,
      accessSource: "connect",
      ...(directAccess ? { directAccess } : {}),
      connectAccess,
      ...(connected.accountId ? { connectAccountId: connected.accountId } : {}),
    };
    environments.set(targetEnvironmentId, registration);
    await this.store.replace(environments);
    return publicEnvironment(registration);
  }

  async signOutConnect(): Promise<{ readonly signedOut: boolean }> {
    return this.connect.signOut();
  }

  async unregisterEnvironment(environmentId: string): Promise<{ readonly environmentId: string; readonly unregistered: true }> {
    if (typeof environmentId !== "string" || !environmentId.trim()) {
      throw new ConnectorError("invalid_input", "environmentId is required.");
    }
    const removed = await this.store.remove(environmentId.trim());
    if (!removed) throw new ConnectorError("environment_not_found", "The selected environment is not saved.");
    return { environmentId: environmentId.trim(), unregistered: true };
  }

  async listProjects(environmentId: string): Promise<readonly PublicProject[]> {
    return listUpstreamProjects(await this.selectEnvironment(environmentId));
  }

  async startTurn(input: StartTurnInput): Promise<PublicStartTurn> {
    const environmentId = typeof input?.environmentId === "string" ? input.environmentId.trim() : "";
    const projectId = typeof input?.projectId === "string" ? input.projectId.trim() : "";
    const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
    if (!environmentId) throw new ConnectorError("invalid_input", "environmentId is required.");
    if (!projectId) throw new ConnectorError("invalid_input", "projectId is required.");
    if (!prompt) throw new ConnectorError("invalid_input", "prompt is required.");
    if (prompt.length > MAX_START_TURN_PROMPT_LENGTH) {
      throw new ConnectorError(
        "invalid_input",
        `prompt must be ${MAX_START_TURN_PROMPT_LENGTH} characters or fewer.`,
      );
    }
    const explicitModelSelection = cleanModelSelection(input.modelSelection);
    const environment = await this.selectEnvironment(environmentId);
    const project = await getProjectForStart(environment, projectId);
    const modelSelection = explicitModelSelection ?? project.defaultModelSelection;
    if (!modelSelection) {
      throw new ConnectorError(
        "upstream_incompatible",
        "The selected project does not provide a model default; supply modelSelection.",
      );
    }

    const threadId = randomUUID();
    const createCommandId = randomUUID();
    const start = {
      environmentId: environment.environmentId,
      projectId,
      threadId,
      createCommandId,
    };
    let createSequence: number;
    try {
      ({ sequence: createSequence } = await dispatchCommand(environment, {
        type: "thread.create",
        commandId: createCommandId,
        threadId,
        projectId,
        title: "New thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      }));
    } catch (error) {
      const failure = safeError(error);
      if (failure.code === "unknown_outcome") {
        return {
          ...start,
          outcome: "unknown",
          error: { code: failure.code, message: failure.message },
        };
      }
      throw failure;
    }

    const turnCommandId = randomUUID();
    let turnSequence: number;
    try {
      ({ sequence: turnSequence } = await dispatchCommand(
        environment,
        threadTurnStartCommand(turnCommandId, threadId, prompt),
      ));
    } catch (error) {
      const failure = safeError(error);
      return {
        ...start,
        outcome: failure.code === "unknown_outcome" ? "unknown" : "partial",
        createSequence,
        turnCommandId,
        error: { code: failure.code, message: failure.message },
      };
    }

    return {
      ...start,
      outcome: "acknowledged",
      createSequence,
      turnCommandId,
      turnSequence,
    };
  }

  async continueTurn(input: ContinueTurnInput): Promise<PublicContinueTurn> {
    const environmentId = typeof input?.environmentId === "string" ? input.environmentId.trim() : "";
    const threadId = typeof input?.threadId === "string" ? input.threadId.trim() : "";
    const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
    if (!environmentId) throw new ConnectorError("invalid_input", "environmentId is required.");
    if (!threadId) throw new ConnectorError("invalid_input", "threadId is required.");
    if (!prompt) throw new ConnectorError("invalid_input", "prompt is required.");
    if (prompt.length > MAX_START_TURN_PROMPT_LENGTH) {
      throw new ConnectorError(
        "invalid_input",
        `prompt must be ${MAX_START_TURN_PROMPT_LENGTH} characters or fewer.`,
      );
    }

    const environment = await this.selectEnvironment(environmentId);
    const thread = await getUpstreamThread(environment, threadId);
    if (thread.status === "starting" || thread.status === "running") {
      throw new ConnectorError(
        "thread_busy",
        "The selected thread has an active turn; wait for it to finish before continuing.",
      );
    }
    if (thread.status === "approval_required") {
      throw new ConnectorError(
        "approval_required",
        "The selected thread is waiting for approval; resolve it in T3 Code before continuing.",
      );
    }
    if (thread.status === "input_required") {
      throw new ConnectorError(
        "input_required",
        "The selected thread is waiting for input; resolve it in T3 Code before continuing.",
      );
    }
    if (thread.status === "unknown") {
      throw new ConnectorError(
        "upstream_incompatible",
        "The selected thread has an unsupported state; inspect it in T3 Code before continuing.",
      );
    }

    const turnCommandId = randomUUID();
    const messageId = randomUUID();
    const continuation = {
      environmentId: environment.environmentId,
      threadId,
      turnCommandId,
      messageId,
    };
    try {
      const { sequence: turnSequence } = await dispatchCommand(
        environment,
        threadTurnStartCommand(turnCommandId, threadId, prompt, messageId),
      );
      return { ...continuation, outcome: "acknowledged", turnSequence };
    } catch (error) {
      const failure = safeError(error);
      if (failure.code === "unknown_outcome") {
        return {
          ...continuation,
          outcome: "unknown",
          error: { code: failure.code, message: failure.message },
        };
      }
      throw failure;
    }
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
