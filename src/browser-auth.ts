import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { ConnectorError } from "./errors.js";

export interface BrowserAuthConfig {
  readonly hostedAppUrl: string;
  readonly jwtTemplate: string;
  readonly relayUrl: string;
}
export interface BrowserGrant {
  readonly sessionId: string;
  readonly accountId: string;
  readonly accessToken: string;
  readonly expiresAt: string;
}
interface ClerkSession {
  readonly id: string;
  readonly status: string;
  readonly user: { readonly id: string };
  readonly currentTask?: unknown;
  getToken(options: { template: string; skipCache: boolean }): Promise<string | null>;
}
interface ClerkWindow extends Window {
  Clerk?: {
    loaded: boolean;
    session?: ClerkSession | null;
    openSignIn(): void;
    signOut(options: { sessionId: string }): Promise<void>;
  };
}
interface OwnedBrowser {
  readonly opening: Promise<BrowserContext>;
  context?: BrowserContext;
  page?: Page;
  closing?: Promise<void>;
  closed: boolean;
}

async function executable(): Promise<string> {
  const configured = process.env.T3_MCP_CONNECT_BROWSER_EXECUTABLE?.trim();
  const candidates = configured ? [configured] : process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ] : process.platform === "win32" ? [
    path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  ] : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Try the next installed executable. */ }
  }
  throw new ConnectorError("connect_auth_failed", "Connect needs installed Chrome or Edge. Set T3_MCP_CONNECT_BROWSER_EXECUTABLE to its executable and start authentication again. Direct environment tools do not need a browser.");
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await lstat(directory);
  if (!file.isDirectory() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
    throw new ConnectorError("storage_error", "The connector-owned browser profile is unavailable or not private.");
  }
}

/** Own profiles and a private browser-control pipe. Only the hosted Clerk SDK handles login. */
export class BrowserProfiles {
  private readonly browsers = new Map<string, OwnedBrowser>();
  private readonly root: string;

  constructor(directory: string) { this.root = path.join(directory, "connect-browser-profiles"); }

  private profilePath(profile: string): string {
    if (!/^[a-f0-9-]{36}$/.test(profile)) throw new ConnectorError("storage_error", "The owned browser profile identity is invalid.");
    return path.join(this.root, profile);
  }

  assertOpen(profile: string): void {
    const owned = this.browsers.get(profile);
    if (!owned?.page || owned.closed || owned.page.isClosed()) {
      throw new ConnectorError("connect_auth_cancelled", "The connector-owned login browser was closed. Start authentication again.");
    }
  }

  private async verifyProfile(profile: string, hostedAppUrl?: string): Promise<void> {
    const directory = this.profilePath(profile);
    const entry = await lstat(directory);
    const markerPath = path.join(directory, ".t3-mcp-profile.json");
    const markerFile = await lstat(markerPath);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 ||
      !markerFile.isFile() || markerFile.isSymbolicLink() || (markerFile.mode & 0o077) !== 0) {
      throw new ConnectorError("storage_error", "The browser profile is not a private connector-owned profile.");
    }
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    if (marker.owner !== "t3-mcp" || marker.profile !== profile ||
      (hostedAppUrl !== undefined && marker.hostedAppUrl !== hostedAppUrl)) {
      throw new ConnectorError("storage_error", "The browser profile ownership or hosted configuration does not match.");
    }
  }

  async open(profile: string, settings: BrowserAuthConfig, interactive: boolean, active: () => void): Promise<void> {
    active();
    const browserPath = await executable();
    await privateDirectory(this.root);
    const profilePath = this.profilePath(profile);
    const fresh = await lstat(profilePath).then(() => false, (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw new ConnectorError("storage_error", "The owned browser profile is unavailable.");
      return true;
    });
    await privateDirectory(profilePath);
    if (fresh) {
      await writeFile(path.join(profilePath, ".t3-mcp-profile.json"), JSON.stringify({ owner: "t3-mcp", profile,
        hostedAppUrl: settings.hostedAppUrl }), { flag: "wx", mode: 0o600 });
    }
    await this.verifyProfile(profile, settings.hostedAppUrl);
    active();
    // Protocol debugging can print evaluate results. Authentication never enables it.
    process.env.DEBUG = "";
    process.env.PWDEBUG = "";
    const { chromium } = await import("playwright-core");
    active();
    if (this.browsers.has(profile)) throw new ConnectorError("connect_auth_pending", "The owned Connect browser is already in use.");
    const opening = chromium.launchPersistentContext(profilePath, {
      executablePath: browserPath,
      headless: !interactive,
      chromiumSandbox: true,
      viewport: null,
      timeout: 10_000,
      ignoreDefaultArgs: ["--enable-automation", "--disable-extensions", "--disable-component-extensions-with-background-pages",
        "--password-store=basic", "--use-mock-keychain"],
      args: ["--no-first-run", "--no-default-browser-check"],
      env: { ...process.env, DEBUG: "", PWDEBUG: "" },
    });
    const owned: OwnedBrowser = { opening, closed: false };
    this.browsers.set(profile, owned);
    try {
      owned.context = await opening;
      owned.context.once("close", () => { owned.closed = true; });
      active();
      if (owned.closed) throw new Error();
      owned.page = owned.context.pages()[0] ?? await owned.context.newPage();
      await owned.page.goto(settings.hostedAppUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await owned.page.waitForFunction(() => (window as ClerkWindow).Clerk?.loaded === true, undefined, { timeout: 20_000 });
      active();
      if (new URL(owned.page.url()).origin !== new URL(settings.hostedAppUrl).origin) throw new Error();
      if (interactive) {
        await owned.page.evaluate(() => {
          const clerk = (window as ClerkWindow).Clerk;
          if (!clerk?.session || clerk.session.status !== "active") clerk?.openSignIn();
        });
      }
    } catch (error) {
      await this.close(profile);
      active();
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("connect_auth_failed", "The owned Connect browser could not open the hosted Clerk UI. Check the browser executable, graphical desktop and network, then start authentication again.");
    }
  }

  async read(profile: string, settings: BrowserAuthConfig, active: () => void): Promise<BrowserGrant | null> {
    active();
    this.assertOpen(profile);
    const owned = this.browsers.get(profile);
    if (!owned?.page || owned.closed || owned.page.isClosed()) {
      throw new ConnectorError("connect_auth_cancelled", "The connector-owned login browser was closed. Start authentication again.");
    }
    if (new URL(owned.page.url()).origin !== new URL(settings.hostedAppUrl).origin) return null;
    let value: { sessionId: string; accountId: string; token: string | null } | null;
    try {
      value = await Promise.race([
        owned.page.evaluate(async (template) => {
          const clerk = (window as ClerkWindow).Clerk;
          const session = clerk?.session;
          if (!clerk?.loaded || !session || session.status !== "active" || session.currentTask) return null;
          const sessionId = session.id, accountId = session.user.id;
          const token = await session.getToken({ template, skipCache: true });
          if (clerk.session?.id !== sessionId || clerk.session.user.id !== accountId) throw new Error("Session changed");
          if (clerk.session.status !== "active" || clerk.session.currentTask) return null;
          return { sessionId, accountId, token };
        }, settings.jwtTemplate),
        new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error()), 10_000); timer.unref(); }),
      ]);
    } catch (error) {
      active();
      if (owned.closed || owned.page.isClosed()) throw new ConnectorError("connect_auth_cancelled", "The connector-owned login browser was closed. Start authentication again.");
      // Navigation through the service's provider redirect may replace the JS context.
      if (error instanceof Error && /Execution context was destroyed|Cannot find context|Frame was detached/.test(error.message)) return null;
      if (new URL(owned.page.url()).origin !== new URL(settings.hostedAppUrl).origin) return null;
      throw new ConnectorError("connect_unavailable", "The hosted Clerk session could not issue a template token. Complete sign-in in the owned browser or retry authentication.");
    }
    active();
    this.assertOpen(profile);
    if (!value) return null;
    if (!value.token) throw new ConnectorError("upstream_incompatible", "The active Clerk session did not issue a relay template JWT.");
    try {
      if (!value.sessionId || !value.accountId || /\s/.test(value.token)) throw new Error();
      const [header, payload, signature, extra] = value.token.split(".");
      const algorithm = JSON.parse(Buffer.from(header!, "base64url").toString()).alg;
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
      if (!signature || extra || typeof algorithm !== "string" || algorithm === "none" ||
        claims.sub !== value.accountId || ![claims.aud].flat().includes("t3-code-relay") ||
        typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) throw new Error();
      return { sessionId: value.sessionId, accountId: value.accountId, accessToken: value.token,
        expiresAt: new Date(claims.exp * 1000).toISOString() };
    } catch { throw new ConnectorError("upstream_incompatible", "Clerk did not issue a usable relay-audience template JWT for the selected browser session."); }
  }

  async signOut(profile: string, sessionId: string, settings: BrowserAuthConfig): Promise<void> {
    try {
      if (!this.browsers.has(profile)) await this.open(profile, settings, false, () => undefined);
      const page = this.browsers.get(profile)?.page;
      if (page && new URL(page.url()).origin === new URL(settings.hostedAppUrl).origin) {
        await Promise.race([page.evaluate(async (id) => {
          const clerk = (window as ClerkWindow).Clerk;
          if (clerk?.session?.id === id) await clerk.signOut({ sessionId: id });
        }, sessionId), new Promise((resolve) => { const timer = setTimeout(resolve, 1000); timer.unref(); })]);
      }
    } catch { /* Local profile removal still signs this connector out. */ }
    finally { await this.discard(profile); }
  }

  async close(profile: string): Promise<void> {
    const owned = this.browsers.get(profile);
    if (!owned) return;
    if (owned.closing) return owned.closing;
    owned.closed = true;
    const closing = (async () => {
      try { await (owned.context ?? await owned.opening).close(); } catch { /* Browser already exited. */ }
      if (this.browsers.get(profile) === owned) this.browsers.delete(profile);
    })();
    owned.closing = closing;
    await closing;
  }

  async discard(profile: string): Promise<void> {
    await this.close(profile);
    const directory = this.profilePath(profile);
    try {
      const root = await lstat(this.root);
      if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0) throw new Error();
      await this.verifyProfile(profile);
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ConnectorError("storage_error", "The owned Connect browser profile could not be removed.");
    }
  }

  async discardAll(active: () => boolean = () => true): Promise<void> {
    if (!active()) return;
    await this.closeAll();
    if (!active()) return;
    try {
      const root = await lstat(this.root);
      if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0) throw new Error();
      for (const profile of await readdir(this.root)) {
        if (!active()) return;
        if (!/^[a-f0-9-]{36}$/.test(profile)) continue;
        // Remove only directories bearing our ownership marker, including interrupted logins.
        try { await this.verifyProfile(profile); }
        catch { continue; }
        if (!active()) return;
        await this.discard(profile);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ConnectorError("storage_error", "The owned Connect browser profiles could not be cleared.");
    }
  }

  async closeAll(): Promise<void> { await Promise.all([...this.browsers.keys()].map((profile) => this.close(profile))); }
}
