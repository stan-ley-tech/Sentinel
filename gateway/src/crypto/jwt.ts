// Hand-rolled HS256 JWT verification — the TypeScript mirror of the
// control plane's Python encoder (control-plane/app/jwt.py). Both follow
// RFC 7519 exactly, so there is one well-understood algorithm to keep in
// sync rather than two divergent third-party libraries.

import { createHmac, timingSafeEqual } from "node:crypto";

export class InvalidTokenError extends Error {}

function base64UrlDecode(input: string): Buffer {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface JwtPayload {
  sub?: string;
  role?: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

export function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new InvalidTokenError("malformed token");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const expectedSig = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();

  let actualSig: Buffer;
  try {
    actualSig = base64UrlDecode(signatureB64);
  } catch {
    throw new InvalidTokenError("malformed signature");
  }
  if (actualSig.length !== expectedSig.length || !timingSafeEqual(actualSig, expectedSig)) {
    throw new InvalidTokenError("signature mismatch");
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as JwtPayload;
  } catch {
    throw new InvalidTokenError("malformed payload");
  }

  if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) {
    throw new InvalidTokenError("token expired");
  }
  return payload;
}
