// Authentication: X-Api-Key (hashed and matched against config) or
// Authorization: Bearer <JWT> (verified with the shared HS256 secret, then
// re-resolved against the current config by subject id — never trusting a
// role claim baked into a possibly-stale token over the live config).

import { createHash } from "node:crypto";

import { InvalidTokenError, verifyJwt } from "../crypto/jwt.js";
import type { PipelineContext, Rejection } from "./context.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function authenticate(ctx: PipelineContext): Rejection | null {
  if (!ctx.route.authRequired) return null;

  const apiKeyHeader = ctx.req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.length > 0) {
    const hash = sha256Hex(apiKeyHeader);
    const key = ctx.config.apiKeys.find((k) => k.keyHash === hash);
    if (key === undefined || !key.enabled) {
      return { statusCode: 401, error: "invalid API key" };
    }
    ctx.principal = { apiKeyId: key.id, role: key.role, authMethod: "api-key" };
    return null;
  }

  const authHeader = ctx.req.headers["authorization"];
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length);
    let payload;
    try {
      payload = verifyJwt(token, ctx.config.jwtSecret);
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        return { statusCode: 401, error: `invalid token: ${err.message}` };
      }
      throw err;
    }

    if (typeof payload.sub !== "string") {
      return { statusCode: 401, error: "invalid token: missing subject" };
    }
    const key = ctx.config.apiKeys.find((k) => k.id === payload.sub);
    if (key === undefined || !key.enabled) {
      return { statusCode: 401, error: "invalid token: unknown or disabled subject" };
    }
    ctx.principal = { apiKeyId: key.id, role: key.role, authMethod: "jwt" };
    return null;
  }

  return { statusCode: 401, error: "missing credentials (X-Api-Key or Authorization: Bearer)" };
}
