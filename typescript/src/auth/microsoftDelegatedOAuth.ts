export { FileRefreshTokenStore } from "./fileRefreshTokenStore.js";

const PERSONAL_ACCOUNT_TOKEN_ENDPOINT =
  "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const APPROVED_SCOPES = ["offline_access", "Mail.ReadWrite", "Mail.Send"] as const;
const REFRESH_EARLY_MS = 60_000;

type Environment = Readonly<Record<string, string | undefined>>;

export type DisabledMicrosoftDelegatedOAuthConfig = {
  enabled: false;
};

export type EnabledMicrosoftDelegatedOAuthConfig = {
  enabled: true;
  clientId: string;
  mailbox: string;
  refreshTokenFile: string;
  tokenEndpoint: typeof PERSONAL_ACCOUNT_TOKEN_ENDPOINT;
  scopes: [...typeof APPROVED_SCOPES];
};

export type MicrosoftDelegatedOAuthConfig =
  DisabledMicrosoftDelegatedOAuthConfig | EnabledMicrosoftDelegatedOAuthConfig;

export interface RefreshTokenStore {
  read(): Promise<string>;
  replace(token: string): Promise<void>;
}

export class MicrosoftDelegatedOAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MicrosoftDelegatedOAuthError";
  }
}

function fail(code: string): never {
  throw new MicrosoftDelegatedOAuthError(code);
}

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required when Outlook is enabled.`);
  return value;
}

function safeSecret(value: unknown, code: string): string {
  if (typeof value !== "string") fail(code);
  const cleaned = value.trim();
  if (!cleaned || /[\r\n]/u.test(cleaned)) fail(code);
  return cleaned;
}

export function resolveMicrosoftDelegatedOAuthConfig(
  environment: Environment = process.env,
): MicrosoftDelegatedOAuthConfig {
  const enabled = environment.JARVIS_OUTLOOK_ENABLED;
  if (enabled === undefined || enabled === "false") return { enabled: false };
  if (enabled !== "true") throw new Error("JARVIS_OUTLOOK_ENABLED must be true or false.");

  const clientId = required(environment, "JARVIS_OUTLOOK_CLIENT_ID");
  const mailbox = required(environment, "JARVIS_OUTLOOK_MAILBOX");
  const refreshTokenFile = required(environment, "JARVIS_OUTLOOK_REFRESH_TOKEN_FILE");
  if (!refreshTokenFile.startsWith("/")) {
    throw new Error("JARVIS_OUTLOOK_REFRESH_TOKEN_FILE must be an absolute path.");
  }

  return {
    enabled: true,
    clientId,
    mailbox,
    refreshTokenFile,
    tokenEndpoint: PERSONAL_ACCOUNT_TOKEN_ENDPOINT,
    scopes: [...APPROVED_SCOPES],
  };
}

export type MicrosoftDelegatedAccessTokenSupplierOptions = {
  clientId: string;
  scopes: readonly string[];
  tokenEndpoint: string;
  refreshTokenStore: RefreshTokenStore;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

type CachedAccessToken = {
  token: string;
  usableUntil: number;
};

export class MicrosoftDelegatedAccessTokenSupplier {
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private cached: CachedAccessToken | undefined;
  private pending: Promise<string> | undefined;

  constructor(private readonly options: MicrosoftDelegatedAccessTokenSupplierOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    if (!options.clientId.trim()) fail("microsoft-oauth-client-id-invalid");
    if (options.tokenEndpoint !== PERSONAL_ACCOUNT_TOKEN_ENDPOINT) {
      fail("microsoft-oauth-token-endpoint-invalid");
    }
    if (options.scopes.join(" ") !== APPROVED_SCOPES.join(" ")) {
      fail("microsoft-oauth-scopes-invalid");
    }
  }

  async getAccessToken(signal: AbortSignal): Promise<string> {
    const cached = this.cached;
    if (cached && this.now() < cached.usableUntil) return cached.token;
    if (this.pending) return this.pending;

    const pending = this.refresh(signal).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  private async refresh(signal: AbortSignal): Promise<string> {
    let refreshToken: string;
    try {
      refreshToken = safeSecret(
        await this.options.refreshTokenStore.read(),
        "microsoft-oauth-refresh-token-invalid",
      );
    } catch (error: unknown) {
      if (error instanceof MicrosoftDelegatedOAuthError) throw error;
      fail("microsoft-oauth-refresh-token-unavailable");
    }

    let response: Response;
    try {
      response = await this.fetch(this.options.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.options.clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: this.options.scopes.join(" "),
        }).toString(),
        redirect: "error",
        signal,
      });
    } catch {
      fail("microsoft-oauth-refresh-request-failed");
    }

    if (response.status !== 200) fail(`microsoft-oauth-refresh-rejected-${response.status}`);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      fail("microsoft-oauth-refresh-response-invalid");
    }
    if (typeof payload !== "object" || payload === null) {
      fail("microsoft-oauth-refresh-response-invalid");
    }
    const record = payload as Record<string, unknown>;
    if (record.token_type !== "Bearer") fail("microsoft-oauth-refresh-response-invalid");
    const accessToken = safeSecret(record.access_token, "microsoft-oauth-refresh-response-invalid");
    if (
      typeof record.expires_in !== "number" ||
      !Number.isSafeInteger(record.expires_in) ||
      record.expires_in < 120 ||
      record.expires_in > 86_400
    ) {
      fail("microsoft-oauth-refresh-response-invalid");
    }
    if (typeof record.scope !== "string") fail("microsoft-oauth-refresh-response-invalid");
    const granted = new Set(record.scope.split(/\s+/u).filter(Boolean));
    if (!this.options.scopes.every((scope) => granted.has(scope))) {
      fail("microsoft-oauth-scopes-missing");
    }

    if (record.refresh_token !== undefined) {
      const rotated = safeSecret(record.refresh_token, "microsoft-oauth-refresh-response-invalid");
      if (rotated !== refreshToken) {
        try {
          await this.options.refreshTokenStore.replace(rotated);
        } catch {
          fail("microsoft-oauth-refresh-token-persist-failed");
        }
      }
    }

    this.cached = {
      token: accessToken,
      usableUntil: this.now() + record.expires_in * 1_000 - REFRESH_EARLY_MS,
    };
    return accessToken;
  }
}
