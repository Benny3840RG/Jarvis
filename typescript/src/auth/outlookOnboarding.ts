import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import {
  APPROVED_SCOPES,
  FileRefreshTokenStore,
  MicrosoftDelegatedAccessTokenSupplier,
} from "./microsoftDelegatedOAuth.js";
import type { OutlookConnection } from "./microsoftOutlookConnections.js";

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.uid !== process.getuid?.()
  ) {
    throw new Error("outlook-onboarding-directory-must-be-private-and-owned");
  }
}

export async function probeOutlookMailbox(
  connection: OutlookConnection,
  token: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<void> {
  const response = await request(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(connection.config.mailbox)}/mailFolders/inbox?$select=id`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal,
    },
  );
  if (response.status !== 200) throw new Error(`outlook-mailbox-probe-rejected-${response.status}`);
  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("id" in payload) ||
    typeof payload.id !== "string" ||
    !payload.id
  ) {
    throw new Error("outlook-mailbox-probe-invalid");
  }
}

export async function verifyOutlookConnection(connection: OutlookConnection): Promise<void> {
  const signal = AbortSignal.timeout(30_000);
  const supplier = new MicrosoftDelegatedAccessTokenSupplier({
    ...connection.config,
    refreshTokenStore: new FileRefreshTokenStore(connection.config.refreshTokenFile),
  });
  await probeOutlookMailbox(connection, await supplier.getAccessToken(signal), signal);
}

export async function authorizeOutlookConnection(
  connection: OutlookConnection,
  options: {
    showAuthorizationUrl(url: string): Promise<void>;
    fetch?: typeof fetch;
  },
): Promise<void> {
  const directory = dirname(connection.config.refreshTokenFile);
  await assertPrivateDirectory(directory);
  // An existing grant is renewed with verify; reconnect uses a new token path.
  try {
    await lstat(connection.config.refreshTokenFile);
    throw new Error("outlook-onboarding-token-exists-use-verify-or-new-path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const request = options.fetch ?? fetch;
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Attach immediately so a timeout while the browser launches cannot be unhandled.
  void codePromise.catch(() => undefined);
  let consumed = false;
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      res.writeHead(400).end("Invalid callback.");
      return;
    }
    if (
      consumed ||
      req.method !== "GET" ||
      url.pathname !== "/" ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.get("state") !== state
    ) {
      res.writeHead(400).end("Invalid callback.");
      return;
    }
    if (url.searchParams.has("error")) {
      consumed = true;
      res.writeHead(400).end("Microsoft sign-in was not completed. Return to the terminal.");
      rejectCode(new Error("outlook-onboarding-consent-rejected"));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.getAll("code").length !== 1 || code.length > 16_384) {
      res.writeHead(400).end("Invalid callback.");
      return;
    }
    consumed = true;
    res
      .writeHead(200, { "Content-Type": "text/plain" })
      .end("Sign-in received. Return to the terminal for verification.");
    resolveCode(code);
  });
  const timeout = setTimeout(
    () => rejectCode(new Error("outlook-onboarding-sign-in-timeout")),
    180_000,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("outlook-onboarding-listener-failed");
    // Microsoft ignores the ephemeral port for registered native localhost redirects.
    const redirectUri = `http://localhost:${address.port}`;
    const authorize = new URL(connection.config.tokenEndpoint.replace(/\/token$/u, "/authorize"));
    authorize.search = new URLSearchParams({
      client_id: connection.config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: APPROVED_SCOPES.join(" "),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      prompt: "select_account",
      login_hint: connection.config.mailbox,
    }).toString();
    await options.showAuthorizationUrl(authorize.toString());
    const code = await codePromise;
    const signal = AbortSignal.timeout(30_000);
    const response = await request(connection.config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "error",
      signal,
      body: new URLSearchParams({
        client_id: connection.config.clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        scope: APPROVED_SCOPES.join(" "),
      }).toString(),
    });
    if (response.status !== 200)
      throw new Error(`outlook-onboarding-exchange-rejected-${response.status}`);
    const payload: unknown = await response.json();
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("refresh_token" in payload) ||
      typeof payload.refresh_token !== "string" ||
      !payload.refresh_token.trim() ||
      /[\r\n]/u.test(payload.refresh_token) ||
      Buffer.byteLength(payload.refresh_token) > 65_536
    )
      throw new Error("outlook-onboarding-refresh-token-missing");
    let token = payload.refresh_token;
    const supplier = new MicrosoftDelegatedAccessTokenSupplier({
      ...connection.config,
      fetch: request,
      refreshTokenStore: {
        async read() {
          return token;
        },
        async replace(value) {
          token = value;
        },
      },
    });
    await probeOutlookMailbox(connection, await supplier.getAccessToken(signal), signal, request);
    await assertPrivateDirectory(directory);
    const handle = await open(connection.config.refreshTokenFile, "wx", 0o600);
    try {
      await handle.writeFile(`${token}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    clearTimeout(timeout);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
