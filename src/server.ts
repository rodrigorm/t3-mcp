import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  EnvironmentConnector,
  type AddEnvironmentInput,
} from "./connector.js";
import { ConnectorError } from "./errors.js";
import { MAX_THREAD_HISTORY_TURN_LIMIT } from "./types.js";

const environmentSchema = z.object({
  id: z.string(),
  label: z.string(),
  endpoint: z.string(),
  serverVersion: z.string(),
  orchestrationProtocolVersion: z.number().int(),
  scopes: z.array(z.string()),
  sessionExpiresAt: z.string(),
  pairedAt: z.string(),
});
const errorSchema = z.object({ code: z.string(), message: z.string() });
const addResultSchema = z.object({
  environment: environmentSchema.optional(),
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

const addInputSchema = z.object({
  pairingUrl: z.string().trim().min(1).max(8192).optional(),
  endpoint: z.string().trim().min(1).max(8192).optional(),
  grant: z.string().trim().min(1).max(4096).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  environmentId: z.string().trim().min(1).max(512).optional(),
});

type AddInput = z.infer<typeof addInputSchema>;
const environmentIdInputSchema = z.object({
  environmentId: z.string().trim().min(1).max(512),
});
const getThreadInputSchema = environmentIdInputSchema.extend({
  threadId: z.string().trim().min(1).max(512),
  turnLimit: z.number().int().min(1).max(MAX_THREAD_HISTORY_TURN_LIMIT).optional(),
  beforeCursor: z.string().trim().min(1).max(4096).optional(),
});

type EnvironmentIdInput = z.infer<typeof environmentIdInputSchema>;
type GetThreadInput = z.infer<typeof getThreadInputSchema>;

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

async function run<T>(operation: () => Promise<T>, build: (value: T) => Record<string, unknown>) {
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
      run(
        () => connector.addEnvironment(input satisfies AddEnvironmentInput),
        (environment) => ({ environment }),
      ),
  );
  server.registerTool(
    "list_environments",
    {
      description: "List saved T3 Code environments without returning credentials.",
      inputSchema: z.object({}),
      outputSchema: listResultSchema,
      annotations: { destructiveHint: false, idempotentHint: true, readOnlyHint: true },
    },
    async () => run(() => connector.listEnvironments(), (environments) => ({ environments })),
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
      run(
        () => connector.listProjects(input.environmentId),
        (projects) => ({ environmentId: input.environmentId, projects }),
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
      run(
        () => connector.getThread(input satisfies GetThreadInput),
        (thread) => ({ thread }),
      ),
  );
  return server;
}
