import { randomUUID } from "node:crypto";

import { ConnectorError } from "./errors.js";
import { EnvironmentStore } from "./storage.js";
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
  type PairedEnvironment,
  type PublicEnvironment,
  type PublicContinueTurn,
  type PublicProject,
  type PublicStartTurn,
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
