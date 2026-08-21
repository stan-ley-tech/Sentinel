// Basic request validation. Checked against the Content-Length header
// (not a buffered body) so this stage costs nothing for the common,
// streamed, non-signed request path.

import type { PipelineContext, Rejection } from "./context.js";

export const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB

export function validateRequest(ctx: PipelineContext): Rejection | null {
  const contentLength = ctx.req.headers["content-length"];
  if (typeof contentLength === "string") {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      return { statusCode: 413, error: `request body exceeds ${MAX_BODY_BYTES} byte limit`, stage: "validate" };
    }
  }
  return null;
}
