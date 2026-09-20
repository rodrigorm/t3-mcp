import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConnectorError } from "./errors.js";
import type { PairedEnvironment } from "./types.js";

interface StoreFile {
  readonly version: 1;
  readonly environments: Record<string, PairedEnvironment>;
}

function defaultStateDirectory(): string {
  if (process.env.T3_MCP_STATE_DIR) {
    return path.resolve(process.env.T3_MCP_STATE_DIR);
  }

  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "t3-mcp");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "t3-mcp");
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "t3-mcp");
}

function isPrivateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function invalidStore(): ConnectorError {
  return new ConnectorError("storage_error", "Environment registrations are unavailable.");
}

function isPairedEnvironment(value: unknown): value is PairedEnvironment {
  if (!value || typeof value !== "object") return false;
  const environment = value as Record<string, unknown>;
  return (
    typeof environment.environmentId === "string" &&
    typeof environment.label === "string" &&
    typeof environment.endpoint === "string" &&
    typeof environment.serverVersion === "string" &&
    environment.orchestrationProtocolVersion === 1 &&
    Array.isArray(environment.scopes) &&
    environment.scopes.every((scope) => typeof scope === "string") &&
    typeof environment.sessionExpiresAt === "string" &&
    typeof environment.pairedAt === "string" &&
    typeof environment.accessToken === "string" &&
    environment.accessToken.length > 0 &&
    environment.tokenType === "Bearer"
  );
}

export class EnvironmentStore {
  readonly directory: string;
  readonly filePath: string;

  constructor(directory = defaultStateDirectory()) {
    this.directory = path.resolve(directory);
    this.filePath = path.join(this.directory, "environments.json");
  }

  async read(): Promise<Map<string, PairedEnvironment>> {
    await this.ensureDirectory();
    let raw: string;
    try {
      const file = await lstat(this.filePath);
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        (process.platform !== "win32" && !isPrivateMode(file.mode))
      ) {
        throw invalidStore();
      }
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw invalidStore();
    }

    try {
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed.version !== 1 || !parsed.environments || typeof parsed.environments !== "object") {
        throw invalidStore();
      }
      const environments = new Map<string, PairedEnvironment>();
      for (const [id, environment] of Object.entries(parsed.environments)) {
        if (id !== environment.environmentId || !isPairedEnvironment(environment)) {
          throw invalidStore();
        }
        environments.set(id, environment);
      }
      return environments;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw invalidStore();
    }
  }

  async replace(environments: Map<string, PairedEnvironment>): Promise<void> {
    await this.ensureDirectory();
    const temporaryPath = path.join(this.directory, `.environments-${process.pid}-${randomUUID()}.tmp`);
    const contents = JSON.stringify(
      {
        version: 1,
        environments: Object.fromEntries(environments),
      } satisfies StoreFile,
      null,
      2,
    ) + "\n";

    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(contents, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
      if (process.platform !== "win32") {
        await chmod(this.filePath, 0o600);
      }
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw invalidStore();
    }
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw invalidStore();
      }
      if (process.platform !== "win32") {
        await chmod(this.directory, 0o700);
      }
    } catch {
      throw invalidStore();
    }
  }
}
