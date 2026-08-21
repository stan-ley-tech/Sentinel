import type { IncomingMessage } from "node:http";

import type { GatewayConfig, RouteConfig } from "../config/types.js";

export interface Principal {
  apiKeyId: string;
  role: string;
  authMethod: "api-key" | "jwt";
}

export interface PipelineContext {
  req: IncomingMessage;
  method: string;
  pathname: string;
  search: string;
  clientIp: string;
  route: RouteConfig;
  config: GatewayConfig;
  /** Full request body. Only populated when the route requires a
   * signature — otherwise the request streams straight through to the
   * upstream and this stays empty. */
  body: Buffer;
  /** Set by the auth stage on success; null until then / for
   * auth-not-required routes. */
  principal: Principal | null;
}

export interface Rejection {
  statusCode: number;
  error: string;
}
