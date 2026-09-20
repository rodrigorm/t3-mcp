#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { EnvironmentConnector } from "./connector.js";
import { createServer } from "./server.js";
import { EnvironmentStore } from "./storage.js";

const server = createServer(new EnvironmentConnector(new EnvironmentStore()));
await server.connect(new StdioServerTransport());
