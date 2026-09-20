import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { EnvironmentConnector, type AddEnvironmentInput } from "./connector.js";
import { ConnectorError } from "./errors.js";

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

const addInputSchema = z.object({
  pairingUrl: z.string().trim().min(1).max(8192).optional(),
  endpoint: z.string().trim().min(1).max(8192).optional(),
  grant: z.string().trim().min(1).max(4096).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  environmentId: z.string().trim().min(1).max(512).optional(),
});

type AddInput = z.infer<typeof addInputSchema>;

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
  return server;
}
