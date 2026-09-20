import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  EnvironmentConnector,
  type AddEnvironmentInput,
  type AttachConnectEnvironmentInput,
  type ConnectAuthInput,
  type ContinueTurnInput as ConnectorContinueTurnInput,
  type RegisterConnectEnvironmentInput,
  type StartTurnInput as ConnectorStartTurnInput,
} from "./connector.js";
import { ConnectorError } from "./errors.js";
import { MAX_START_TURN_PROMPT_LENGTH, MAX_THREAD_HISTORY_TURN_LIMIT } from "./types.js";

const environmentSchema = z.object({
  id: z.string(),
  label: z.string(),
  endpoint: z.string(),
  serverVersion: z.string(),
  orchestrationProtocolVersion: z.number().int(),
  scopes: z.array(z.string()),
  sessionExpiresAt: z.string(),
  pairedAt: z.string(),
  source: z.enum(["direct", "connect"]).optional(),
  connectAttached: z.boolean().optional(),
});
const errorSchema = z.object({ code: z.string(), message: z.string() });
const addResultSchema = z.object({
  environment: environmentSchema.optional(),
  error: errorSchema.optional(),
});
const connectAuthSchema = z.object({
  status: z.enum(["signed_out", "pending", "authenticated", "failed", "cancelled"]),
  authorizationUrl: z.string().optional(),
  expiresAt: z.string().optional(),
  error: errorSchema.optional(),
});
const connectAuthResultSchema = z.object({ authentication: connectAuthSchema });
const connectEnvironmentSchema = z.object({
  id: z.string(),
  label: z.string(),
  endpoint: z.string(),
  linkedAt: z.string(),
});
const connectEnvironmentListResultSchema = z.object({
  environments: z.array(connectEnvironmentSchema).optional(),
  error: errorSchema.optional(),
});
const unregisterResultSchema = z.object({
  environmentId: z.string().optional(),
  unregistered: z.literal(true).optional(),
  error: errorSchema.optional(),
});
const listResultSchema = z.object({
  environments: z.array(environmentSchema).optional(),
  error: errorSchema.optional(),
});
const projectSchema = z.object({ id: z.string(), name: z.string() });
const listProjectsResultSchema = z.object({
  environmentId: z.string().optional(),
  projects: z.array(projectSchema).optional(),
  error: errorSchema.optional(),
});
const messageSchema = z.object({
  id: z.string(),
  role: z.string(),
  text: z.string(),
  turnId: z.string().nullable(),
  streaming: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const activitySchema = z.object({
  id: z.string(),
  tone: z.string(),
  kind: z.string(),
  summary: z.string(),
  turnId: z.string().nullable(),
  createdAt: z.string(),
});
const historySchema = z.object({
  turnLimit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
  snapshotSequence: z.number().int(),
  threadSequence: z.number().int().optional(),
});
const threadSchema = z.object({
  environmentId: z.string(),
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.enum([
    "idle",
    "starting",
    "running",
    "completed",
    "interrupted",
    "error",
    "approval_required",
    "input_required",
    "unknown",
  ]),
  upstreamState: z.string().optional(),
  messages: z.array(messageSchema),
  activities: z.array(activitySchema),
  history: historySchema,
});
const getThreadResultSchema = z.object({
  thread: threadSchema.optional(),
  error: errorSchema.optional(),
});
const startTurnSchema = z.object({
  environmentId: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  outcome: z.enum(["acknowledged", "partial", "unknown"]),
  createCommandId: z.string(),
  turnCommandId: z.string().optional(),
  createSequence: z.number().int().optional(),
  turnSequence: z.number().int().optional(),
  error: errorSchema.optional(),
});
const startTurnResultSchema = z.object({
  start: startTurnSchema.optional(),
  error: errorSchema.optional(),
});
const continueTurnSchema = z.object({
  environmentId: z.string(),
  threadId: z.string(),
  outcome: z.enum(["acknowledged", "unknown"]),
  turnCommandId: z.string(),
  messageId: z.string(),
  turnSequence: z.number().int().optional(),
  error: errorSchema.optional(),
});
const continueTurnResultSchema = z.object({
  continuation: continueTurnSchema.optional(),
  error: errorSchema.optional(),
});

const addInputSchema = z.object({
  pairingUrl: z.string().trim().min(1).max(8192).optional(),
  endpoint: z.string().trim().min(1).max(8192).optional(),
  grant: z.string().trim().min(1).max(4096).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  environmentId: z.string().trim().min(1).max(512).optional(),
});

const connectAuthInputSchema = z.object({
  action: z.enum(["start", "status", "cancel"]).optional(),
});
const registerConnectInputSchema = z.object({
  environmentId: z.string().trim().min(1).max(512),
  label: z.string().trim().min(1).max(200).optional(),
});
const attachConnectInputSchema = z.object({
  environmentId: z.string().trim().min(1).max(512),
  targetEnvironmentId: z.string().trim().min(1).max(512),
  label: z.string().trim().min(1).max(200).optional(),
});

type AddInput = z.infer<typeof addInputSchema>;
type ConnectAuthToolInput = z.infer<typeof connectAuthInputSchema>;
type RegisterConnectToolInput = z.infer<typeof registerConnectInputSchema>;
type AttachConnectToolInput = z.infer<typeof attachConnectInputSchema>;
const environmentIdInputSchema = z.object({
  environmentId: z.string().trim().min(1).max(512),
});
const getThreadInputSchema = environmentIdInputSchema.extend({
  threadId: z.string().trim().min(1).max(512),
  turnLimit: z.number().int().min(1).max(MAX_THREAD_HISTORY_TURN_LIMIT).optional(),
  beforeCursor: z.string().trim().min(1).max(4096).optional(),
});
const modelSelectionSchema = z.object({
  instanceId: z.string().trim().min(1).max(512),
  model: z.string().trim().min(1).max(512),
  options: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(512),
        value: z.union([z.string().trim().min(1).max(4096), z.boolean()]),
      }),
    )
    .optional(),
});
const startTurnInputSchema = environmentIdInputSchema.extend({
  projectId: z.string().trim().min(1).max(512),
  prompt: z.string().trim().min(1).max(MAX_START_TURN_PROMPT_LENGTH),
  modelSelection: modelSelectionSchema.optional(),
});
const continueTurnInputSchema = environmentIdInputSchema.extend({
  threadId: z.string().trim().min(1).max(512),
  prompt: z.string().trim().min(1).max(MAX_START_TURN_PROMPT_LENGTH),
});

type EnvironmentIdInput = z.infer<typeof environmentIdInputSchema>;
type GetThreadInput = z.infer<typeof getThreadInputSchema>;
type StartTurnToolInput = z.infer<typeof startTurnInputSchema>;
type ContinueTurnToolInput = z.infer<typeof continueTurnInputSchema>;

function textResult(structuredContent: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(isError ? { isError: true as const } : {}),
  };
}

function errorResult(error: unknown) {
  const safeError =
    error instanceof ConnectorError
      ? error
      : new ConnectorError("internal_error", "The connector could not complete the request.");
  const structuredContent = { error: { code: safeError.code, message: safeError.message } };
  return textResult(structuredContent, true);
}

async function runTool<T>(operation: () => Promise<T>, build: (value: T) => Record<string, unknown>) {
  try {
    return textResult(build(await operation()));
  } catch (error) {
    return errorResult(error);
  }
}

export function createServer(connector: EnvironmentConnector): McpServer {
  const server = new McpServer({ name: "t3-mcp", version: "0.1.0" });
  server.registerTool(
    "add_environment",
    {
      description:
        "Pair a T3 Code environment directly and save its scoped session for future MCP requests.",
      inputSchema: addInputSchema,
      outputSchema: addResultSchema,
      annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false },
    },
    async (input: AddInput) =>
      runTool(
        () => connector.addEnvironment(input satisfies AddEnvironmentInput),
        (environment) => ({ environment }),
      ),
  );
  server.registerTool(
    "connect_authenticate",
    {
      description:
        "Start, inspect, or cancel operator-driven T3 Connect browser authentication without returning credentials.",
      inputSchema: connectAuthInputSchema,
      outputSchema: connectAuthResultSchema,
      annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false },
    },
    async (input: ConnectAuthToolInput) =>
      runTool(
        () => connector.connectAuth(input satisfies ConnectAuthInput),
        (authentication) => ({ authentication }),
      ),
  );
  server.registerTool(
    "list_connect_environments",
    {
      description: "List environments available through T3 Connect without saving or selecting them.",
      inputSchema: z.object({}),
      outputSchema: connectEnvironmentListResultSchema,
      annotations: { destructiveHint: false, idempotentHint: true, readOnlyHint: true },
    },
    async () => runTool(() => connector.listConnectEnvironments(), (environments) => ({ environments })),
  );
  server.registerTool(
    "register_connect_environment",
    {
      description:
        "Explicitly register one selected T3 Connect environment and obtain its environment-issued session.",
      inputSchema: registerConnectInputSchema,
      outputSchema: addResultSchema,
      annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false },
    },
    async (input: RegisterConnectToolInput) =>
      runTool(
        () => connector.registerConnectEnvironment(input satisfies RegisterConnectEnvironmentInput),
        (environment) => ({ environment }),
      ),
  );
  server.registerTool(
    "attach_connect_environment",
    {
      description:
        "Explicitly attach Connect access to a saved registration after its environment identity matches.",
      inputSchema: attachConnectInputSchema,
      outputSchema: addResultSchema,
      annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false },
    },
    async (input: AttachConnectToolInput) =>
      runTool(
        () => connector.attachConnectEnvironment(input satisfies AttachConnectEnvironmentInput),
        (environment) => ({ environment }),
      ),
  );
  server.registerTool(
    "sign_out_connect",
    {
      description:
        "Sign out of T3 Connect without removing saved environments or their environment sessions.",
      inputSchema: z.object({}),
      outputSchema: z.object({ signedOut: z.boolean(), error: errorSchema.optional() }),
      annotations: { destructiveHint: false, idempotentHint: true, readOnlyHint: false },
    },
    async () => runTool(() => connector.signOutConnect(), (result) => result),
  );
  server.registerTool(
    "unregister_environment",
    {
      description:
        "Remove one saved environment and its locally retained access; this does not revoke its upstream session.",
      inputSchema: environmentIdInputSchema,
      outputSchema: unregisterResultSchema,
      annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
    },
    async (input: EnvironmentIdInput) =>
      runTool(() => connector.unregisterEnvironment(input.environmentId), (result) => result),
  );
  server.registerTool(
    "list_environments",
    {
      description: "List saved T3 Code environments without returning credentials.",
      inputSchema: z.object({}),
      outputSchema: listResultSchema,
      annotations: { destructiveHint: false, idempotentHint: true, readOnlyHint: true },
    },
    async () => runTool(() => connector.listEnvironments(), (environments) => ({ environments })),
  );
  server.registerTool(
    "list_projects",
    {
      description: "List projects from one explicitly selected T3 Code environment.",
      inputSchema: environmentIdInputSchema,
      outputSchema: listProjectsResultSchema,
      annotations: { destructiveHint: false, idempotentHint: true, readOnlyHint: true },
    },
    async (input: EnvironmentIdInput) =>
      runTool(
        () => connector.listProjects(input.environmentId),
        (projects) => ({ environmentId: input.environmentId, projects }),
      ),
  );
  server.registerTool(
    "start_turn",
    {
      description:
        "Create a thread and submit its first turn in an explicitly selected environment and project.",
      inputSchema: startTurnInputSchema,
      outputSchema: startTurnResultSchema,
      annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false },
    },
    async (input: StartTurnToolInput) =>
      runTool(
        () => connector.startTurn(input satisfies ConnectorStartTurnInput),
        (start) => ({ start }),
      ),
  );
  server.registerTool(
    "continue_turn",
    {
      description: "Submit a new turn to an explicitly selected existing thread.",
      inputSchema: continueTurnInputSchema,
      outputSchema: continueTurnResultSchema,
      annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false },
    },
    async (input: ContinueTurnToolInput) =>
      runTool(
        () => connector.continueTurn(input satisfies ConnectorContinueTurnInput),
        (continuation) => ({ continuation }),
      ),
  );
  server.registerTool(
    "get_thread",
    {
      description:
        "Read one thread from an explicitly selected environment with bounded, paginated history.",
      inputSchema: getThreadInputSchema,
      outputSchema: getThreadResultSchema,
      annotations: { destructiveHint: false, idempotentHint: true, readOnlyHint: true },
    },
    async (input: GetThreadInput) =>
      runTool(
        () => connector.getThread(input satisfies GetThreadInput),
        (thread) => ({ thread }),
      ),
  );
  return server;
}
