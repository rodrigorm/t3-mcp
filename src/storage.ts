import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConnectorError } from "./errors.js";
import type { DpopPrivateJwk, EnvironmentAccess, PairedEnvironment } from "./types.js";

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

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isPairedEnvironment(value: unknown): value is PairedEnvironment {
  if (!value || typeof value !== "object") return false;
  const environment = value as Record<string, unknown>;
  const accessValid = (access: unknown): access is EnvironmentAccess => {
    if (!access || typeof access !== "object") return false;
    const candidate = access as Record<string, unknown>;
    return (
      typeof candidate.endpoint === "string" &&
      typeof candidate.serverVersion === "string" &&
      candidate.orchestrationProtocolVersion === 1 &&
      Array.isArray(candidate.scopes) &&
      candidate.scopes.every((scope) => typeof scope === "string") &&
      typeof candidate.sessionExpiresAt === "string" &&
      typeof candidate.pairedAt === "string" &&
      typeof candidate.accessToken === "string" &&
      candidate.accessToken.length > 0 &&
      (candidate.tokenType === "Bearer" ||
        (candidate.tokenType === "DPoP" && isDpopPrivateJwk(candidate.dpopPrivateJwk)))
    );
  };
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
    (environment.tokenType === "Bearer" ||
      (environment.tokenType === "DPoP" && isDpopPrivateJwk(environment.dpopPrivateJwk))) &&
    (environment.accessSource === undefined ||
      environment.accessSource === "direct" ||
      environment.accessSource === "connect") &&
    (environment.directAccess === undefined || accessValid(environment.directAccess)) &&
    (environment.connectAccess === undefined || accessValid(environment.connectAccess)) &&
    (environment.connectAccountId === undefined || typeof environment.connectAccountId === "string")
  );
}

function isDpopPrivateJwk(value: unknown): value is DpopPrivateJwk {
  if (!value || typeof value !== "object") return false;
  const key = value as Record<string, unknown>;
  return (
    key.kty === "EC" &&
    key.crv === "P-256" &&
    typeof key.x === "string" &&
    typeof key.y === "string" &&
    typeof key.d === "string" &&
    key.x.length > 0 &&
    key.y.length > 0 &&
    key.d.length > 0
  );
}

export class EnvironmentStore {
  readonly directory: string;
  readonly filePath: string;
  private pending: Promise<unknown> = Promise.resolve();
  // Keep deletion revisions so a removed and recreated target invalidates older exchanges.
  private readonly revisions = new Map<string, number>();
  private readonly snapshots = new WeakMap<PairedEnvironment, number>();

  constructor(directory = defaultStateDirectory()) {
    this.directory = path.resolve(directory);
    this.filePath = path.join(this.directory, "environments.json");
  }

  async read(): Promise<Map<string, PairedEnvironment>> {
    return this.serialized(() => this.readCurrent());
  }

  private async readCurrent(): Promise<Map<string, PairedEnvironment>> {
    await this.ensureDirectory();
    let raw: string;
    try {
      const file = await lstat(this.filePath);
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        !isPrivateMode(file.mode)
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
        this.snapshots.set(environment, this.revisions.get(id) ?? 0);
      }
      return environments;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw invalidStore();
    }
  }

  async save(registration: PairedEnvironment, expected?: PairedEnvironment): Promise<void> {
    await this.serialized(async () => {
      const environments = await this.readCurrent();
      const id = registration.environmentId;
      const current = environments.get(id);
      if (expected) {
        if (!current) {
          throw new ConnectorError("environment_not_found", "The selected environment is no longer saved.");
        }
        if (
          this.snapshots.get(expected) !== (this.revisions.get(id) ?? 0) ||
          JSON.stringify(current) !== JSON.stringify(expected)
        ) {
          throw new ConnectorError(
            "environment_conflict",
            "The saved environment changed during pairing; select it again before retrying.",
          );
        }
      } else if (current) {
        throw new ConnectorError(
          "environment_exists",
          "An environment with this identifier is already saved; select it explicitly to update access.",
        );
      }
      environments.set(id, registration);
      await this.replace(environments);
      this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    });
  }

  private async replace(environments: Map<string, PairedEnvironment>): Promise<void> {
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
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw invalidStore();
    }
  }

  async remove(environmentId: string): Promise<boolean> {
    return this.serialized(async () => {
      const environments = await this.readCurrent();
      if (!environments.delete(environmentId)) return false;
      await this.replace(environments);
      this.revisions.set(environmentId, (this.revisions.get(environmentId) ?? 0) + 1);
      return true;
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    // A failed write must not prevent later requests from using the store.
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async ensureDirectory(): Promise<void> {
    try {
      if (isInside(path.resolve(process.cwd()), this.directory)) {
        throw invalidStore();
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw invalidStore();
      }
      if (isInside(await realpath(process.cwd()), await realpath(this.directory))) {
        throw invalidStore();
      }
      await chmod(this.directory, 0o700);
    } catch {
      throw invalidStore();
    }
  }
}

export interface ConnectAuth {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly accountId?: string;
  readonly dpopPrivateJwk: DpopPrivateJwk;
}

interface ConnectStoreFile {
  readonly version: 1;
  readonly auth?: ConnectAuth;
}

function isConnectAuth(value: unknown): value is ConnectAuth {
  if (!value || typeof value !== "object") return false;
  const auth = value as Record<string, unknown>;
  return (
    typeof auth.accessToken === "string" &&
    auth.accessToken.length > 0 &&
    typeof auth.refreshToken === "string" &&
    typeof auth.expiresAt === "string" &&
    isDpopPrivateJwk(auth.dpopPrivateJwk) &&
    (auth.accountId === undefined || typeof auth.accountId === "string")
  );
}

export class ConnectStore {
  readonly directory: string;
  readonly filePath: string;

  constructor(directory = defaultStateDirectory()) {
    this.directory = path.resolve(directory);
    this.filePath = path.join(this.directory, "connect.json");
  }

  async read(): Promise<ConnectAuth | null> {
    await this.ensureDirectory();
    let raw: string;
    try {
      const file = await lstat(this.filePath);
      if (!file.isFile() || file.isSymbolicLink() || !isPrivateMode(file.mode)) {
        throw invalidStore();
      }
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw invalidStore();
    }

    try {
      const parsed = JSON.parse(raw) as ConnectStoreFile;
      if (parsed.version !== 1 || (parsed.auth !== undefined && !isConnectAuth(parsed.auth))) {
        throw invalidStore();
      }
      return parsed.auth ?? null;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw invalidStore();
    }
  }

  async replace(auth: ConnectAuth): Promise<void> {
    await this.write({ version: 1, auth });
  }

  async clear(): Promise<void> {
    await this.ensureDirectory();
    await rm(this.filePath, { force: true }).catch(() => {
      throw invalidStore();
    });
  }

  private async write(value: ConnectStoreFile): Promise<void> {
    await this.ensureDirectory();
    const temporaryPath = path.join(this.directory, `.connect-${process.pid}-${randomUUID()}.tmp`);
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw invalidStore();
    }
  }

  private async ensureDirectory(): Promise<void> {
    try {
      if (isInside(path.resolve(process.cwd()), this.directory)) throw invalidStore();
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw invalidStore();
      if (isInside(await realpath(process.cwd()), await realpath(this.directory))) throw invalidStore();
      await chmod(this.directory, 0o700);
    } catch {
      throw invalidStore();
    }
  }
}
