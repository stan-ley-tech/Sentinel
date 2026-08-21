// RBAC: a route's requiredPermission (if any) must be in the caller's
// role's permission list, or the role must hold the "*" wildcard.

import type { PipelineContext, Rejection } from "./context.js";

export function authorize(ctx: PipelineContext): Rejection | null {
  if (ctx.route.requiredPermission === null) return null;

  if (ctx.principal === null) {
    return { statusCode: 401, error: "authentication required for this route", stage: "authorize" };
  }

  const permissions = ctx.config.roles[ctx.principal.role]?.permissions ?? [];
  if (permissions.includes(ctx.route.requiredPermission) || permissions.includes("*")) {
    return null;
  }
  return {
    statusCode: 403,
    error: `role '${ctx.principal.role}' lacks permission '${ctx.route.requiredPermission}'`,
    stage: "authorize",
  };
}
