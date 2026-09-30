import { ConnectorError } from "./errors.js";

export interface NativeConfig {
  readonly frontendApiUrl: string;
  readonly publishableKey: string;
  readonly jwtTemplate: string;
  readonly relayUrl: string;
}

export interface LoginView {
  readonly step: "identify" | "factor" | "complete" | "cancelled";
  readonly strategies?: readonly string[];
  readonly selected?: string;
  readonly second?: boolean;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorError("upstream_incompatible", "Clerk returned an invalid native authentication response.");
  }
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(value)) {
    throw new ConnectorError("upstream_incompatible", "Clerk returned an invalid resource identity.");
  }
  return value;
}

function unsupported(message: string): never {
  throw new ConnectorError("connect_auth_failed", message);
}

/** Public Clerk Native Frontend API. Credentials and resource identities stay in Node. */
export class NativeClerk {
  private credential: string;
  private queue: Promise<unknown> = Promise.resolve();
  private attempt: Record<string, unknown> | undefined;
  private selected: Record<string, unknown> | undefined;
  private second = false;

  constructor(
    private readonly settings: NativeConfig,
    credential: string,
    private readonly rotate: (token: string) => Promise<void>,
    private readonly assertActive: () => void,
  ) { this.credential = credential; }

  get token(): string { return this.credential; }

  private request(path: string, method = "GET", fields?: Record<string, string>, timeout = 10_000): Promise<Record<string, unknown>> {
    const operation = this.queue.then(async () => {
      this.assertActive();
      const url = new URL(`v1/${path}`, this.settings.frontendApiUrl);
      url.searchParams.set("_is_native", "1");
      url.searchParams.set("__clerk_api_version", "2026-05-12");
      let response: Response;
      try {
        response = await fetch(url, { method, redirect: "error", credentials: "omit",
          signal: AbortSignal.timeout(timeout), headers: {
            ...(this.credential ? { authorization: `Bearer ${this.credential}` } : {}),
            ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          }, ...(method === "POST" ? { body: new URLSearchParams(fields) } : {}) });
      } catch {
        throw new ConnectorError("connect_unavailable", "Clerk could not be reached safely.");
      }
      this.assertActive();
      // Header rotations apply to error responses too, before any subsequent request.
      const authorization = response.headers.get("authorization");
      if (authorization !== null) {
        const token = authorization.replace(/^Bearer\s+/i, "").trim();
        if (!token || token.length > 16_384 || /\s/.test(token)) {
          throw new ConnectorError("upstream_incompatible", "Clerk returned an invalid client credential.");
        }
        await this.rotate(token);
        this.assertActive();
        this.credential = token;
      }
      let data: Record<string, unknown>;
      try { data = object(await response.json()); } catch {
        throw new ConnectorError("upstream_incompatible", "Clerk returned invalid authentication JSON.");
      }
      this.assertActive();
      if (!response.ok) {
        const errors = Array.isArray(data.errors) ? data.errors : [];
        const codes = errors.map((error) => error && typeof error === "object" ? (error as Record<string, unknown>).code : undefined);
        if (response.status === 401 || codes.some((code) => ["session_not_found", "session_revoked", "client_not_found"].includes(String(code)))) {
          throw new ConnectorError("connect_auth_expired", "The connector's Clerk session is no longer active; authenticate again.");
        }
        if (codes.some((code) => typeof code === "string" && /captcha|protect|challenge/.test(code))) {
          unsupported("Clerk requires a CAPTCHA or Protect challenge that this local UI does not support. Complete account recovery in T3, then retry an allowed existing-account factor.");
        }
        if (response.status >= 500) throw new ConnectorError("connect_unavailable", "Clerk is temporarily unavailable.");
        unsupported("Clerk rejected the sign-in input. Check the identifier, password or verification code and retry.");
      }
      // Resource endpoints wrap response/client; token endpoints return { jwt } directly.
      return object(Object.hasOwn(data, "response") ? data.response : data);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async identify(identifier: string): Promise<LoginView> {
    if (!this.credential) {
      await this.request("client", "POST");
      if (!this.credential) unsupported("Clerk did not issue a native Client API credential. Check Native API configuration.");
    }
    this.attempt = await this.request("client/sign_ins", "POST", { identifier });
    this.selected = undefined;
    return this.advance();
  }

  private factors(): Record<string, unknown>[] {
    const factors = this.attempt?.[this.second ? "supported_second_factors" : "supported_first_factors"];
    return Array.isArray(factors) ? factors.map(object) : [];
  }

  private supported(): Record<string, unknown>[] {
    return this.factors().filter((factor) => this.second
      ? ["totp", "backup_code", "phone_code", "email_code"].includes(String(factor.strategy))
      : ["email_code", "password"].includes(String(factor.strategy)));
  }

  private async advance(): Promise<LoginView> {
    const attempt = this.attempt;
    if (!attempt) return { step: "identify" };
    if (attempt.protect_check || attempt.status === "needs_protect_check") unsupported("Clerk requires a Protect challenge that this local UI does not support. Resolve the account challenge in T3 before retrying.");
    if (attempt.status === "complete") { id(attempt.created_session_id); return { step: "complete" }; }
    if (!["needs_first_factor", "needs_second_factor", "needs_client_trust"].includes(String(attempt.status))) {
      unsupported("Clerk requires an unsupported sign-in step, identifier change, or password reset. Recover the existing account in T3 and retry; this UI does not register accounts or bypass tasks.");
    }
    const second = attempt.status !== "needs_first_factor";
    if (this.second !== second) this.selected = undefined;
    this.second = second;
    const factors = this.supported();
    if (!factors.length) {
      if (this.second) unsupported("Clerk requires a second factor or client-trust verification unavailable in this UI. Supported methods are authenticator code, backup code, SMS code and email code when Clerk offers them. Recover the factor in T3 and retry.");
      unsupported("This account offers no email-code or password first factor. Social/SSO redirects need a registered native callback; passkeys need an OS bridge. Configure an allowed email-code/password factor through T3 account settings, then retry here.");
    }
    if (!this.selected) return this.choose(String(factors[0]!.strategy));
    return { step: "factor", strategies: factors.map((factor) => String(factor.strategy)),
      selected: String(this.selected.strategy), second: this.second };
  }

  async choose(strategy: string): Promise<LoginView> {
    const factor = this.supported().find((entry) => entry.strategy === strategy);
    if (!factor) unsupported("That factor is not offered by this Clerk sign-in attempt.");
    this.selected = factor;
    const fields: Record<string, string> = { strategy };
    if (["email_code", "phone_code"].includes(strategy)) {
      const field = strategy === "email_code" ? "email_address_id" : "phone_number_id";
      fields[field] = id(factor[field]);
      this.attempt = await this.request(`client/sign_ins/${id(this.attempt?.id)}/prepare_${this.second ? "second" : "first"}_factor`, "POST", fields);
    }
    return this.advance();
  }

  async verify(value: string): Promise<LoginView> {
    if (!this.selected || !this.attempt) unsupported("Identify the account and choose a supported factor first.");
    const strategy = String(this.selected.strategy);
    this.attempt = await this.request(`client/sign_ins/${id(this.attempt.id)}/attempt_${this.second ? "second" : "first"}_factor`, "POST",
      { strategy, [strategy === "password" ? "password" : "code"]: value });
    return this.advance();
  }

  async ownedSession(sessionId = id(this.attempt?.created_session_id), accountId?: string): Promise<{ sessionId: string; accountId: string }> {
    const client = await this.request("client");
    const sessions = Array.isArray(client.sessions) ? client.sessions.map(object) : [];
    const session = sessions.find((entry) => entry.id === sessionId);
    if (sessions.length !== 1 || !session) {
      throw new ConnectorError("connect_account_conflict", "Clerk did not prove one connector-owned session; sign out before switching accounts.");
    }
    const validate = (value: Record<string, unknown>) => {
      if (value.current_task || (Array.isArray(value.tasks) && value.tasks.length)) {
        unsupported("Clerk requires pending session tasks. Complete them in T3 account settings and retry; the connector cannot bypass them.");
      }
      if (value.id !== sessionId || value.status !== "active" ||
        typeof value.expire_at !== "number" || !Number.isFinite(value.expire_at) || value.expire_at <= Date.now()) {
        throw new ConnectorError("connect_auth_expired", "The connector's Clerk session expired or was revoked; authenticate again.");
      }
      const userId = id(object(value.user).id);
      if (accountId && userId !== accountId) throw new ConnectorError("connect_account_conflict", "A different Clerk account was returned; sign out before switching accounts.");
      return userId;
    };
    const userId = validate(session);
    const loaded = await this.request(`client/sessions/${id(sessionId)}`);
    if (validate(loaded) !== userId) throw new ConnectorError("connect_account_conflict", "Clerk returned conflicting session ownership.");
    const touched = await this.request(`client/sessions/${id(sessionId)}/touch`, "POST", { intent: "select_session" });
    if (validate(touched) !== userId) throw new ConnectorError("connect_account_conflict", "Clerk returned conflicting session ownership.");
    return { sessionId, accountId: userId };
  }

  async template(sessionId: string, accountId: string): Promise<{ accessToken: string; expiresAt: string }> {
    const response = await this.request(`client/sessions/${id(sessionId)}/tokens/${encodeURIComponent(this.settings.jwtTemplate)}`, "POST");
    try {
      if (typeof response.jwt !== "string" || /\s/.test(response.jwt)) throw new Error();
      const [header, payload, signature, extra] = response.jwt.split(".");
      const alg = object(JSON.parse(Buffer.from(header!, "base64url").toString())).alg;
      const claims = object(JSON.parse(Buffer.from(payload!, "base64url").toString()));
      if (!signature || extra || typeof alg !== "string" || alg === "none" || claims.sub !== accountId ||
        ![claims.aud].flat().includes("t3-code-relay") || typeof claims.exp !== "number" ||
        !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) throw new Error();
      // Compatibility only. The relay's authenticated discovery verifies the signature.
      return { accessToken: response.jwt, expiresAt: new Date(claims.exp * 1000).toISOString() };
    } catch { throw new ConnectorError("upstream_incompatible", "Clerk did not issue a usable relay-audience template JWT."); }
  }

  async end(sessionId: string): Promise<void> { await this.request(`client/sessions/${id(sessionId)}/end`, "POST", undefined, 1000); }
}
