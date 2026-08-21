// Request-signing HMAC: signature = hex(HMAC-SHA256(secret,
// "<timestamp>.<nonce>." + body)). Verified in constant time.

import { createHmac, timingSafeEqual } from "node:crypto";

export function computeSignature(secret: string, timestamp: string, nonce: string, body: Buffer): string {
  const signingInput = Buffer.concat([Buffer.from(`${timestamp}.${nonce}.`, "utf8"), body]);
  return createHmac("sha256", secret).update(signingInput).digest("hex");
}

export function verifySignature(
  secret: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
  providedSignatureHex: string,
): boolean {
  const expected = Buffer.from(computeSignature(secret, timestamp, nonce, body), "hex");

  let provided: Buffer;
  try {
    provided = Buffer.from(providedSignatureHex, "hex");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
