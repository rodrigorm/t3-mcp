import { ConnectorError } from "./errors.js";
import { endpointPath, publicEndpoint, type ValidatedEndpoint } from "./url.js";
import {
  REQUIRED_SCOPES,
  SUPPORTED_ORCHESTRATION_PROTOCOL_VERSION,
  DEFAULT_THREAD_HISTORY_TURN_LIMIT,
  type PairedEnvironment,
  type EnvironmentDescriptor,
  type PairingResult,
  type PublicProject,
  type PublicThread,
  type PublicThreadActivity,
  type PublicThreadMessage,
  type PublicThreadStatus,
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
  errorCode: "descriptor" | "pairing" | "session" | "projects" | "thread",
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
    if ((errorCode === "projects" || errorCode === "thread") && response.status === 401) {
      throw new ConnectorError(
        "session_expired",
        "The saved environment session expired or was revoked; pair the environment again.",
      );
    }
    if (response.status === 403) {
      throw new ConnectorError("permission_denied", "The environment denied this operation.");
    }
    if (errorCode === "thread" && response.status === 404) {
      throw new ConnectorError("thread_not_found", "The requested thread was not found.");
    }
    throw new ConnectorError(
      errorCode === "descriptor" || errorCode === "projects" || errorCode === "thread"
        ? "upstream_incompatible"
        : "transport_error",
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

function invalidOrchestration(message: string): never {
  throw new ConnectorError("upstream_incompatible", message);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || requiredString(value);
}

function parseProjects(value: unknown): readonly PublicProject[] {
  if (!isRecord(value) || !Array.isArray(value.projects)) {
    return invalidOrchestration("The environment returned an invalid project snapshot.");
  }

  const projects: PublicProject[] = [];
  for (const project of value.projects) {
    if (
      !isRecord(project) ||
      !requiredString(project.id) ||
      !requiredString(project.title) ||
      (project.deletedAt !== undefined &&
        project.deletedAt !== null &&
        !requiredString(project.deletedAt))
    ) {
      return invalidOrchestration("The environment returned an invalid project snapshot.");
    }
    if (project.deletedAt !== undefined && project.deletedAt !== null) continue;
    projects.push({ id: project.id.trim(), name: project.title.trim() });
  }
  return projects;
}

interface UpstreamActivity extends PublicThreadActivity {
  readonly payload: unknown;
}

function parseMessages(value: unknown): readonly PublicThreadMessage[] {
  if (!Array.isArray(value)) {
    return invalidOrchestration("The environment returned an invalid thread snapshot.");
  }

  const messages: PublicThreadMessage[] = [];
  for (const message of value) {
    if (
      !isRecord(message) ||
      !requiredString(message.id) ||
      !requiredString(message.role) ||
      typeof message.text !== "string" ||
      !nullableString(message.turnId) ||
      typeof message.streaming !== "boolean" ||
      !requiredString(message.createdAt) ||
      !requiredString(message.updatedAt)
    ) {
      return invalidOrchestration("The environment returned an invalid thread snapshot.");
    }
    messages.push({
      id: message.id.trim(),
      role: message.role.trim(),
      text: message.text,
      turnId: message.turnId === null ? null : message.turnId.trim(),
      streaming: message.streaming,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    });
  }
  return messages;
}

function parseActivities(value: unknown): readonly UpstreamActivity[] {
  if (!Array.isArray(value)) {
    return invalidOrchestration("The environment returned an invalid thread snapshot.");
  }

  const activities: UpstreamActivity[] = [];
  for (const activity of value) {
    if (
      !isRecord(activity) ||
      !requiredString(activity.id) ||
      !requiredString(activity.tone) ||
      !requiredString(activity.kind) ||
      !requiredString(activity.summary) ||
      !nullableString(activity.turnId) ||
      !requiredString(activity.createdAt)
    ) {
      return invalidOrchestration("The environment returned an invalid thread snapshot.");
    }
    activities.push({
      id: activity.id.trim(),
      tone: activity.tone.trim(),
      kind: activity.kind.trim(),
      summary: activity.summary.trim(),
      turnId: activity.turnId === null ? null : activity.turnId.trim(),
      createdAt: activity.createdAt,
      payload: activity.payload,
    });
  }
  return activities;
}

function pendingRequestKind(activities: readonly UpstreamActivity[]): "approval" | "input" | null {
  const pending = new Map<string, "approval" | "input">();
  for (const activity of activities) {
    const payload = isRecord(activity.payload) ? activity.payload : undefined;
    const requestId = requiredString(payload?.requestId) ? payload.requestId.trim() : undefined;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      pending.set(requestId ?? activity.id, activity.kind === "approval.requested" ? "approval" : "input");
      continue;
    }
    if (requestId === undefined) continue;
    if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      pending.delete(requestId);
      continue;
    }
    if (
      activity.kind === "provider.approval.respond.failed" ||
      activity.kind === "provider.user-input.respond.failed"
    ) {
      const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : "";
      if (detail.includes("stale") || detail.includes("unknown")) pending.delete(requestId);
    }
  }
  if ([...pending.values()].includes("approval")) return "approval";
  if (pending.size > 0) return "input";
  return null;
}

function parseThreadState(
  thread: Record<string, unknown>,
): { readonly latestState?: string; readonly sessionStatus?: string } {
  if (!("latestTurn" in thread) || !("session" in thread)) {
    return invalidOrchestration("The environment returned an invalid thread snapshot.");
  }

  let latestState: string | undefined;
  if (thread.latestTurn !== null) {
    if (!isRecord(thread.latestTurn) || !requiredString(thread.latestTurn.state)) {
      return invalidOrchestration("The environment returned an invalid thread snapshot.");
    }
    latestState = thread.latestTurn.state.trim();
  }

  let sessionStatus: string | undefined;
  if (thread.session !== null) {
    if (!isRecord(thread.session) || !requiredString(thread.session.status)) {
      return invalidOrchestration("The environment returned an invalid thread snapshot.");
    }
    sessionStatus = thread.session.status.trim();
  }
  return { latestState, sessionStatus };
}

function mapThreadStatus(
  latestState: string | undefined,
  sessionStatus: string | undefined,
  pending: "approval" | "input" | null,
): PublicThreadStatus {
  if (pending === "approval") return "approval_required";
  if (pending === "input") return "input_required";
  if (sessionStatus === "starting") return "starting";
  if (sessionStatus === "running") return "running";
  if (sessionStatus === "error") return "error";
  if (sessionStatus !== undefined && !["idle", "ready", "interrupted", "stopped"].includes(sessionStatus)) {
    return "unknown";
  }
  if (latestState === "running") return "running";
  if (latestState === "completed") return "completed";
  if (latestState === "interrupted") return "interrupted";
  if (latestState === "error") return "error";
  if (latestState !== undefined) return "unknown";
  if (sessionStatus === "interrupted" || sessionStatus === "stopped") return "interrupted";
  return "idle";
}

function parseHistory(
  value: unknown,
  turnLimit: number,
  snapshotSequence: number,
): PublicThread["history"] {
  if (value === undefined) {
    return {
      turnLimit,
      hasMore: false,
      nextCursor: null,
      truncated: false,
      snapshotSequence,
    };
  }
  if (
    !isRecord(value) ||
    !nullableString(value.beforeCursor) ||
    typeof value.hasMore !== "boolean" ||
    !nonNegativeInteger(value.snapshotSequence) ||
    (value.threadSequence !== undefined && !nonNegativeInteger(value.threadSequence))
  ) {
    return invalidOrchestration("The environment returned invalid thread pagination metadata.");
  }
  return {
    turnLimit,
    hasMore: value.hasMore,
    nextCursor: value.beforeCursor === null ? null : value.beforeCursor.trim(),
    truncated: value.hasMore,
    snapshotSequence: value.snapshotSequence,
    ...(value.threadSequence === undefined ? {} : { threadSequence: value.threadSequence }),
  };
}

function parseThread(
  value: unknown,
  environmentId: string,
  requestedThreadId: string,
  turnLimit: number,
): PublicThread {
  if (
    !isRecord(value) ||
    !nonNegativeInteger(value.snapshotSequence) ||
    !isRecord(value.thread) ||
    !requiredString(value.thread.id) ||
    !requiredString(value.thread.projectId) ||
    !requiredString(value.thread.title)
  ) {
    return invalidOrchestration("The environment returned an invalid thread snapshot.");
  }
  if (value.thread.id.trim() !== requestedThreadId) {
    return invalidOrchestration("The environment returned a different thread than requested.");
  }

  const messages = parseMessages(value.thread.messages);
  const activities = parseActivities(value.thread.activities);
  const states = parseThreadState(value.thread);
  const pending = pendingRequestKind(activities);
  const unknownState = [states.latestState, states.sessionStatus].find(
    (state) =>
      state !== undefined &&
      !["idle", "starting", "running", "ready", "interrupted", "stopped", "error", "completed"].includes(state),
  );
  const upstreamState = unknownState ?? states.sessionStatus ?? states.latestState;
  return {
    environmentId,
    id: value.thread.id.trim(),
    projectId: value.thread.projectId.trim(),
    title: value.thread.title.trim(),
    status: mapThreadStatus(states.latestState, states.sessionStatus, pending),
    ...(upstreamState === undefined ? {} : { upstreamState }),
    messages,
    activities: activities.map(({ payload: _payload, ...activity }) => activity),
    history: parseHistory(value.page, turnLimit, value.snapshotSequence),
  };
}

export async function listProjects(environment: PairedEnvironment): Promise<readonly PublicProject[]> {
  const response = await request(
    endpointPath(new URL(environment.endpoint), "/api/orchestration/snapshot"),
    { method: "GET", headers: { authorization: `${environment.tokenType} ${environment.accessToken}` } },
    "projects",
  );
  return parseProjects(await json(response, "upstream_incompatible"));
}

export async function getThread(
  environment: PairedEnvironment,
  threadId: string,
  turnLimit = DEFAULT_THREAD_HISTORY_TURN_LIMIT,
  beforeCursor?: string,
): Promise<PublicThread> {
  const url = endpointPath(
    new URL(environment.endpoint),
    `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
  );
  url.searchParams.set("turnLimit", String(turnLimit));
  if (beforeCursor !== undefined) url.searchParams.set("beforeCursor", beforeCursor);
  const response = await request(
    url,
    { method: "GET", headers: { authorization: `${environment.tokenType} ${environment.accessToken}` } },
    "thread",
  );
  return parseThread(await json(response, "upstream_incompatible"), environment.environmentId, threadId, turnLimit);
}

export { publicEndpoint };
