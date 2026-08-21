// Orchestrates the ordered stage chain: IP filter -> auth -> authorize ->
// validate -> [signing -> replay, only for signature-required routes].
// The request body is only read into memory for routes that need to
// verify a signature over it; everything else stays a pure stream all the
// way to the upstream, which matters for proxy throughput.

import type { IncomingMessage } from "node:http";

import type { GatewayConfig, RouteConfig } from "../config/types.js";
import { authenticate } from "./auth.js";
import { authorize } from "./authorize.js";
import type { PipelineContext, Rejection } from "./context.js";
import { checkIpRules } from "./ipFilter.js";
import { checkReplay, ReplayGuard } from "./replay.js";
import { verifyRequestSignature } from "./signing.js";
import { validateRequest } from "./validate.js";

export { ReplayGuard };

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
}

export async function runPipeline(
  req: IncomingMessage,
  pathname: string,
  search: string,
  route: RouteConfig,
  config: GatewayConfig,
  replayGuard: ReplayGuard,
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
    authorize(ctx) ??
    validateRequest(ctx);

  let bufferedBody: Buffer | undefined;
  if (rejection === null && route.requireSignature) {
    ctx.body = await readBody(req);
    bufferedBody = ctx.body;
    rejection = verifyRequestSignature(ctx) ?? checkReplay(ctx, replayGuard);
  }

  return { rejection, bufferedBody };
}
