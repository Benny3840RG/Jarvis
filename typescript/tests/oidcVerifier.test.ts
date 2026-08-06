import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { describe, it } from "node:test";

import { createOidcVerifier } from "../src/http/oidcVerifier.js";

const config = {
  issuer: "https://issuer.example.com/",
  audience: "jarvis-api",
  jwksUrl: "https://issuer.example.com/.well-known/jwks.json",
  clockSkewSeconds: 0,
  subject: "benny",
};

function encode(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function createToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  algorithm = "RS256",
): Promise<string> {
  const header = encode(JSON.stringify({ alg: algorithm, kid: "key-1", typ: "JWT" }));
  const payload = encode(JSON.stringify(claims));
  const signed = new TextEncoder().encode(`${header}.${payload}`);
  const signature = await webcrypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, signed);
  return `${header}.${payload}.${encode(new Uint8Array(signature))}`;
}

describe("OIDC verifier", () => {
  it("verifies a signed access token and reuses the bounded JWKS cache", async () => {
    const pair = (await webcrypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const publicJwk = (await webcrypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & {
      kid?: string;
      alg?: string;
      use?: string;
    };
    publicJwk.kid = "key-1";
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";
    let fetches = 0;
    const verifier = createOidcVerifier(
      config,
      (async () => {
        fetches += 1;
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
      () => 1_700_000_000_000,
    );
    const claims = {
      iss: config.issuer,
      aud: [config.audience, "other-client"],
      sub: "benny",
      exp: 1_700_000_300,
    };
    const token = await createToken(pair.privateKey, claims);

    assert.deepEqual(await verifier.verify(token), {
      subject: "benny",
      issuer: config.issuer,
      audience: config.audience,
    });
    await verifier.verify(token);
    assert.equal(fetches, 1);
  });

  it("rejects a token with the wrong audience or an expired lifetime", async () => {
    const pair = (await webcrypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const publicJwk = (await webcrypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & {
      kid?: string;
      alg?: string;
      use?: string;
    };
    publicJwk.kid = "key-1";
    const verifier = createOidcVerifier(
      config,
      (async () =>
        new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      () => 1_700_000_000_000,
    );

    await assert.rejects(
      verifier.verify(
        await createToken(pair.privateKey, {
          iss: config.issuer,
          aud: "wrong-audience",
          sub: "benny",
          exp: 1_700_000_300,
        }),
      ),
      /OIDC access token verification failed/,
    );
    await assert.rejects(
      verifier.verify(
        await createToken(pair.privateKey, {
          iss: config.issuer,
          aud: config.audience,
          sub: "benny",
          exp: 1_699_999_999,
        }),
      ),
      /OIDC access token verification failed/,
    );
  });
});
