import type { OidcConfig } from "./config.js";

export type OidcIdentity = {
  subject: string;
  issuer: string;
  audience: string;
};

export interface OidcVerifier {
  verify(accessToken: string): Promise<OidcIdentity>;
}

type JsonWebKeyWithId = JsonWebKey & {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
};

class OidcVerificationError extends Error {
  constructor() {
    super("OIDC access token verification failed.");
    this.name = "OidcVerificationError";
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new OidcVerificationError();
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

function decodeJson<T>(value: string): T {
  try {
    return JSON.parse(Buffer.from(decodeBase64Url(value)).toString("utf8")) as T;
  } catch {
    throw new OidcVerificationError();
  }
}

function bearerClaims(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OidcVerificationError();
  }
  return value as Record<string, unknown>;
}

function hasAudience(claim: unknown, expected: string): boolean {
  return typeof claim === "string"
    ? claim === expected
    : Array.isArray(claim) && claim.every((item) => typeof item === "string") && claim.includes(expected);
}

function requiredText(claims: Record<string, unknown>, name: string): string {
  const value = claims[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new OidcVerificationError();
  }
  return value;
}

export function createOidcVerifier(
  config: OidcConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): OidcVerifier {
  let cachedKeys: Map<string, CryptoKey> | undefined;
  let cachedUntil = 0;

  async function loadKeys(force = false): Promise<Map<string, CryptoKey>> {
    if (!force && cachedKeys !== undefined && cachedUntil > now()) return cachedKeys;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetchImpl(config.jwksUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new OidcVerificationError();
      const document = (await response.json()) as { keys?: JsonWebKeyWithId[] };
      if (!Array.isArray(document.keys)) throw new OidcVerificationError();
      const next = new Map<string, CryptoKey>();
      for (const jwk of document.keys) {
        if (
          typeof jwk.kid !== "string" ||
          jwk.kty !== "RSA" ||
          (jwk.alg !== undefined && jwk.alg !== "RS256") ||
          (jwk.use !== undefined && jwk.use !== "sig")
        ) {
          continue;
        }
        try {
          const key = await crypto.subtle.importKey(
            "jwk",
            jwk,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
          next.set(jwk.kid, key);
        } catch {
          // Ignore unusable keys; a valid matching key is required below.
        }
      }
      if (next.size === 0) throw new OidcVerificationError();
      cachedKeys = next;
      cachedUntil = now() + 300_000;
      return next;
    } catch {
      throw new OidcVerificationError();
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async verify(accessToken: string): Promise<OidcIdentity> {
      const parts = accessToken.split(".");
      if (parts.length !== 3) throw new OidcVerificationError();
      const header = decodeJson<{ alg?: unknown; kid?: unknown }>(parts[0]);
      if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0) {
        throw new OidcVerificationError();
      }
      const claims = bearerClaims(decodeJson<unknown>(parts[1]));
      const signature = decodeBase64Url(parts[2]);
      const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      const signatureBuffer = new Uint8Array(signature.byteLength);
      signatureBuffer.set(signature);
      const signedBuffer = new Uint8Array(signed.byteLength);
      signedBuffer.set(signed);
      let keys = await loadKeys();
      let key = keys.get(header.kid);
      if (key === undefined) {
        keys = await loadKeys(true);
        key = keys.get(header.kid);
      }
      if (key === undefined) throw new OidcVerificationError();
      const valid = await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        key,
        signatureBuffer.buffer,
        signedBuffer.buffer,
      );
      if (!valid) throw new OidcVerificationError();

      const nowSeconds = now() / 1_000;
      const skew = config.clockSkewSeconds;
      if (requiredText(claims, "iss") !== config.issuer || !hasAudience(claims.aud, config.audience)) {
        throw new OidcVerificationError();
      }
      if (
        typeof claims.exp !== "number" ||
        !Number.isFinite(claims.exp) ||
        nowSeconds > claims.exp + skew
      ) {
        throw new OidcVerificationError();
      }
      if (
        claims.nbf !== undefined &&
        (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > nowSeconds + skew)
      ) {
        throw new OidcVerificationError();
      }
      return {
        subject: requiredText(claims, "sub"),
        issuer: config.issuer,
        audience: config.audience,
      };
    },
  };
}
