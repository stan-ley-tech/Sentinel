// HMAC request signing verification, for routes with requireSignature.
// Expects three headers: X-Signature (hex HMAC-SHA256), X-Signature-
// Timestamp (unix ms), and X-Nonce (unique per request — also consumed by
// replay.ts). The signing key is the authenticated caller's per-API-key
// signing secret, so this stage must run after auth.ts.

import { verifySignature } from "../crypto/hmac.js";
import type { PipelineContext, Rejection } from "./context.js";

export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes

export function verifyRequestSignature(ctx: PipelineContext): Rejection | null {
  if (!ctx.route.requireSignature) return null;
  if (ctx.principal === null) {
    return { statusCode: 401, error: "signed requests require authentication", stage: "signing" };
  }

  const signature = ctx.req.headers["x-signature"];
  const timestamp = ctx.req.headers["x-signature-timestamp"];
  const nonce = ctx.req.headers["x-nonce"];
  if (typeof signature !== "string" || typeof timestamp !== "string" || typeof nonce !== "string") {
    return { statusCode: 401, error: "missing signing headers (X-Signature, X-Signature-Timestamp, X-Nonce)", stage: "signing" };
  }

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_CLOCK_SKEW_MS) {
    return { statusCode: 401, error: "signature timestamp out of range", stage: "signing" };
  }

  const key = ctx.config.apiKeys.find((k) => k.id === ctx.principal?.apiKeyId);
  if (key === undefined) {
    return { statusCode: 401, error: "unknown signing key", stage: "signing" };
  }

  if (!verifySignature(key.signingSecret, timestamp, nonce, ctx.body, signature)) {
    return { statusCode: 401, error: "invalid request signature", stage: "signing" };
  }
  return null;
}
