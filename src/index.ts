#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { EnvironmentConnector } from "./connector.js";
import { createServer } from "./server.js";
import { EnvironmentStore } from "./storage.js";

process.umask(0o077);
const connector = new EnvironmentConnector(new EnvironmentStore());
const server = createServer(connector);
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try { await connector.close(); await server.close(); } finally { process.exit(0); }
}
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
process.stdin.once("end", () => { void stop(); });
await server.connect(new StdioServerTransport());
