// Orchestrates the ordered stage chain. Cheapest and most abuse-relevant
// checks run first: IP filter needs no state at all; once a caller is
// authenticated, rate limiting and quota are checked before spending any
// more work on them, so an over-budget (but validly authenticated) caller
// is turned away before RBAC lookups or (much more expensive) signature
// verification ever run. The request body is only read into memory for
// routes that need to verify a signature over it — everything else stays
// a pure stream all the way to the upstream.

import type { IncomingMessage } from "node:http";

import type { GatewayConfig, RouteConfig } from "../config/types.js";
import { authenticate } from "./auth.js";
import { authorize } from "./authorize.js";
import type { PipelineContext, Principal, Rejection } from "./context.js";
import { checkIpRules } from "./ipFilter.js";
import { checkQuota, QuotaTracker } from "./quota.js";
import { checkRateLimit, RateLimiter } from "./rateLimit.js";
import { checkReplay, ReplayGuard } from "./replay.js";
import { verifyRequestSignature } from "./signing.js";
import { validateRequest } from "./validate.js";

export { QuotaTracker, RateLimiter, ReplayGuard };

export interface PipelineDeps {
  replayGuard: ReplayGuard;
  rateLimiter: RateLimiter;
  quotaTracker: QuotaTracker;
}

export function createPipelineDeps(): PipelineDeps {
  return { replayGuard: new ReplayGuard(), rateLimiter: new RateLimiter(), quotaTracker: new QuotaTracker() };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function normalizeIp(remoteAddress: string | undefined): string {
  if (remoteAddress === undefined) return "0.0.0.0";
  return remoteAddress.startsWith("::ffff:") ? remoteAddress.slice("::ffff:".length) : remoteAddress;
}

export interface PipelineOutcome {
  rejection: Rejection | null;
  /** Set only when the body was read (signature-required routes) — the
   * caller forwards it to the proxy instead of re-piping the (now
   * consumed) request stream. */
  bufferedBody: Buffer | undefined;
  /** Who the pipeline resolved the caller to be, if anyone — populated
   * even on a later-stage rejection (e.g. authenticated but rate
   * limited), for audit logging. */
  principal: Principal | null;
  clientIp: string;
}

export async function runPipeline(
  req: IncomingMessage,
  pathname: string,
  search: string,
  route: RouteConfig,
  config: GatewayConfig,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const ctx: PipelineContext = {
    req,
    method: req.method ?? "GET",
    pathname,
    search,
    clientIp: normalizeIp(req.socket.remoteAddress),
    route,
    config,
    body: Buffer.alloc(0),
    principal: null,
  };

  let rejection =
    checkIpRules(ctx.clientIp, ctx.config.ipRules) ??
    authenticate(ctx) ??
    checkRateLimit(ctx, deps.rateLimiter) ??
    checkQuota(ctx, deps.quotaTracker) ??
    authorize(ctx) ??
    validateRequest(ctx);

  let bufferedBody: Buffer | undefined;
  if (rejection === null && route.requireSignature) {
    ctx.body = await readBody(req);
    bufferedBody = ctx.body;
    rejection = verifyRequestSignature(ctx) ?? checkReplay(ctx, deps.replayGuard);
  }

  return { rejection, bufferedBody, principal: ctx.principal, clientIp: ctx.clientIp };
}
