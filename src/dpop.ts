import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import type { DpopPrivateJwk, DpopPublicJwk } from "./types.js";

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function publicDpopJwk(key: DpopPrivateJwk): DpopPublicJwk {
  return { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
}

export function dpopThumbprint(key: DpopPrivateJwk | DpopPublicJwk): string {
  return base64Url(
    requireHash(
      json({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }),
    ),
  );
}

function requireHash(value: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value, "utf8").digest());
}

export function generateDpopKey(): DpopPrivateJwk {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateJwk = privateKey.export({ format: "jwk" }) as JsonWebKey & {
    d: string;
    x: string;
    y: string;
  };
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey & {
    x: string;
    y: string;
  };
  return {
    kty: "EC",
    crv: "P-256",
    x: publicJwk.x,
    y: publicJwk.y,
    d: privateJwk.d,
  };
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function createDpopProof(input: {
  readonly key: DpopPrivateJwk;
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string;
}): string {
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: publicDpopJwk(input.key),
  };
  const payload = {
    htm: input.method.toUpperCase(),
    htu: normalizedUrl(input.url),
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    ...(input.accessToken
      ? { ath: base64Url(requireHash(input.accessToken)) }
      : {}),
  };
  const encodedHeader = base64Url(json(header));
  const encodedPayload = base64Url(json(payload));
  const signature = sign(
    "sha256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    { key: createPrivateKey({ key: input.key, format: "jwk" }), dsaEncoding: "ieee-p1363" },
  );
  return `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`;
}
