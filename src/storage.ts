import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  try {
    if (isInside(path.resolve(process.cwd()), directoryPath)) throw invalidStore();
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const directory = await lstat(directoryPath);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw invalidStore();
    if (isInside(await realpath(process.cwd()), await realpath(directoryPath))) throw invalidStore();
    await chmod(directoryPath, 0o700);
  } catch {
    throw invalidStore();
  }
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
  private readonly snapshots = new WeakMap<Map<string, PairedEnvironment>, ReadonlyMap<string, number>>();

  constructor(directory = defaultStateDirectory()) {
    this.directory = path.resolve(directory);
    this.filePath = path.join(this.directory, "environments.json");
  }

  async read(): Promise<Map<string, PairedEnvironment>> {
    return this.serialized(async () => {
      const environments = await this.readCurrent();
      this.snapshots.set(environments, new Map(this.revisions));
      return environments;
    });
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
      }
      return environments;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw invalidStore();
    }
  }

  async save(registration: PairedEnvironment, snapshot: Map<string, PairedEnvironment>, assertActive: () => void = () => undefined): Promise<void> {
    await this.serialized(async () => {
      assertActive();
      const environments = await this.readCurrent();
      assertActive();
      const id = registration.environmentId;
      const current = environments.get(id);
      const expected = snapshot.get(id);
      const expectedRevision = this.snapshots.get(snapshot)?.get(id) ?? 0;
      if (expected) {
        if (!current) {
          throw new ConnectorError("environment_not_found", "The selected environment is no longer saved.");
        }
        if (
          expectedRevision !== (this.revisions.get(id) ?? 0) ||
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
      } else if (expectedRevision !== (this.revisions.get(id) ?? 0)) {
        throw new ConnectorError("environment_conflict", "The environment registration changed during pairing; select it again before retrying.");
      }
      const previous = new Map(environments);
      environments.set(id, registration);
      await this.replace(environments, assertActive);
      try {
        assertActive();
      } catch (error) {
        // Cancellation may arrive while the atomic rename is already in flight.
        await this.replace(previous);
        throw error;
      }
      this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    });
  }

  private async replace(environments: Map<string, PairedEnvironment>, assertActive: () => void = () => undefined): Promise<void> {
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
      assertActive();
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof ConnectorError) throw error;
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
    await ensurePrivateDirectory(this.directory);
  }
}

export interface ConnectAuth {
  /** Cached short-lived template JWT, never the native Client API credential. */
  readonly accessToken: string;
  readonly nativeClientToken: string;
  readonly sessionId: string;
  readonly frontendApiUrl: string;
  readonly publishableKey: string;
  readonly jwtTemplate: string;
  readonly relayUrl: string;
  readonly expiresAt: string;
  readonly accountId?: string;
  readonly dpopPrivateJwk: DpopPrivateJwk;
}

interface ConnectStoreFile {
  readonly version: 2;
  readonly auth?: ConnectAuth;
  readonly pendingNative?: { readonly token: string; readonly frontendApiUrl: string };
}

function isConnectAuth(value: unknown): value is ConnectAuth {
  if (!value || typeof value !== "object") return false;
  const auth = value as Record<string, unknown>;
  return (
    typeof auth.accessToken === "string" &&
    !/\s/.test(auth.accessToken) &&
    typeof auth.nativeClientToken === "string" && !/\s/.test(auth.nativeClientToken) &&
    typeof auth.sessionId === "string" &&
    typeof auth.frontendApiUrl === "string" &&
    typeof auth.publishableKey === "string" &&
    typeof auth.jwtTemplate === "string" &&
    typeof auth.relayUrl === "string" &&
    typeof auth.expiresAt === "string" &&
    Number.isFinite(Date.parse(auth.expiresAt)) &&
    isDpopPrivateJwk(auth.dpopPrivateJwk) &&
    (auth.accountId === undefined || (typeof auth.accountId === "string" && auth.accountId.trim().length > 0))
  );
}

export class ConnectStore {
  readonly directory: string;
  readonly filePath: string;
  private revision = 0;
  private credentialRevision = 0;
  private readonly snapshots = new WeakMap<ConnectAuth, number>();
  private mutations: Promise<unknown> = Promise.resolve();
  private owner: string | undefined;

  get generation(): number {
    return this.revision;
  }

  assertOwner(): void {
    if (!this.owner) return;
    try {
      if (readFileSync(path.join(this.directory, ".connect-owner"), "utf8") === this.owner) return;
    } catch { /* The credential lease was lost. */ }
    throw new ConnectorError("storage_error", "Connect credential ownership changed; restart with a private state directory.");
  }

  constructor(directory = defaultStateDirectory()) {
    this.directory = path.resolve(directory);
    this.filePath = path.join(this.directory, "connect.json");
  }

  async read(): Promise<ConnectAuth | null> {
    return this.mutate(() => this.readCurrent());
  }

  private async readCurrent(): Promise<ConnectAuth | null> {
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
      let parsed = JSON.parse(raw) as ConnectStoreFile;
      // CLI OAuth state cannot renew a Desktop session. Keep its account pin, but
      // discard the obsolete credentials. Environment sessions live in another file.
      if ((parsed as { version: number }).version === 1) {
        const legacy = parsed.auth as unknown as Record<string, unknown> | undefined;
        if (legacy && (!isDpopPrivateJwk(legacy.dpopPrivateJwk) ||
          (legacy.accountId !== undefined && typeof legacy.accountId !== "string"))) throw invalidStore();
        parsed = { version: 2, ...(legacy ? { auth: {
          accessToken: "", nativeClientToken: "", sessionId: "", frontendApiUrl: "", publishableKey: "",
          jwtTemplate: "", relayUrl: "", expiresAt: new Date(0).toISOString(),
          dpopPrivateJwk: legacy.dpopPrivateJwk as DpopPrivateJwk,
          ...(typeof legacy.accountId === "string" ? { accountId: legacy.accountId } : {}),
        } } : {}) };
        await this.write(parsed);
      }
      if (parsed.version !== 2 || (parsed.auth !== undefined && !isConnectAuth(parsed.auth))) {
        throw invalidStore();
      }
      if (parsed.auth) this.snapshots.set(parsed.auth, this.credentialRevision);
      return parsed.auth ?? null;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw invalidStore();
    }
  }

  async replace(auth: ConnectAuth, generation = this.revision, expected?: ConnectAuth): Promise<boolean> {
    return this.mutate(async () => {
      if (generation !== this.revision) return false;
      const previous = await this.readCurrent();
      if (expected && (this.snapshots.get(expected) !== this.credentialRevision ||
        JSON.stringify(previous) !== JSON.stringify(expected))) return false;
      const active = () => { this.assertOwner(); return generation === this.revision; };
      if (!active()) return false;
      if (!(await this.write({ version: 2, auth }, active))) return false;
      if (active()) {
        this.credentialRevision += 1;
        this.snapshots.set(auth, this.credentialRevision);
        return true;
      }
      // Restore the retained login if cancellation raced with rename. All readers
      // wait for this serialized mutation, including its restoration.
      if (previous) await this.write({ version: 2, auth: previous });
      else await rm(this.filePath, { force: true });
      return false;
    });
  }

  invalidateWrites(): Promise<void> {
    this.revision += 1;
    return this.mutations.then(() => undefined);
  }

  async stageNative(token: string, frontendApiUrl: string, generation: number): Promise<boolean> {
    return this.mutate(async () => {
      if (generation !== this.revision) return false;
      const auth = await this.readCurrent();
      const active = () => generation === this.revision;
      if (!(await this.write({ version: 2, ...(auth ? { auth } : {}), pendingNative: { token, frontendApiUrl } }, active))) return false;
      if (active()) return true;
      if (auth) await this.write({ version: 2, auth });
      else await rm(this.filePath, { force: true });
      return false;
    });
  }

  async discardPending(generation = this.revision): Promise<void> {
    return this.mutate(async () => {
      if (generation !== this.revision) return;
      const auth = await this.readCurrent();
      if (auth) await this.write({ version: 2, auth });
      else await rm(this.filePath, { force: true });
    });
  }

  async clear(): Promise<boolean> {
    // Invalidate network work immediately, then clear after any already-started write.
    this.revision += 1;
    return this.mutate(async () => {
      await this.ensureDirectory();
      try {
        await rm(this.filePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw invalidStore();
      }
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.catch(() => undefined);
    return result;
  }

  private async write(value: ConnectStoreFile, active: () => boolean = () => true): Promise<boolean> {
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
      if (!active()) {
        await rm(temporaryPath, { force: true });
        return false;
      }
      await rename(temporaryPath, this.filePath);
      return true;
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw invalidStore();
    }
  }

  private async ensureDirectory(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    this.acquireOwner();
  }

  private acquireOwner(): void {
    if (this.owner) { this.assertOwner(); return; }
    const lock = path.join(this.directory, ".connect-owner");
    const value = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = openSync(lock, "wx", 0o600);
        try { writeFileSync(descriptor, value); } finally { closeSync(descriptor); }
        this.owner = value;
        process.once("exit", () => {
          try { if (readFileSync(lock, "utf8") === value) unlinkSync(lock); } catch { /* Already released. */ }
        });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw invalidStore();
        try {
          const file = lstatSync(lock);
          if (!file.isFile() || file.isSymbolicLink() || !isPrivateMode(file.mode)) throw invalidStore();
          const retained = readFileSync(lock, "utf8");
          const pid = (JSON.parse(retained) as { pid?: unknown }).pid;
          if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw invalidStore();
          try { process.kill(pid, 0); }
          catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === "ESRCH" && readFileSync(lock, "utf8") === retained) {
              unlinkSync(lock); continue;
            }
          }
        } catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ENOENT") continue; }
        throw new ConnectorError("storage_error", "Connect credentials are owned by another connector process or unavailable; use one process per private state directory.");
      }
    }
    throw invalidStore();
  }
}
