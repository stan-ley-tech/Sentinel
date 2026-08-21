// The gateway's in-memory view of control-plane policy — refreshed by
// ConfigClient on every poll. Field names are camelCase here; the wire
// format from the control plane (Python/FastAPI) is snake_case, so
// configClient.ts is responsible for translating between the two.

export interface RoleConfig {
  permissions: string[];
}

export interface ApiKeyConfig {
  id: string;
  keyHash: string;
  role: string;
  signingSecret: string;
  enabled: boolean;
  rateLimitPerSecond: number | null;
  rateLimitBurst: number | null;
  quotaLimit: number | null;
  quotaPeriod: "day" | "month" | null;
}

export interface RouteConfig {
  id: string;
  pathPrefix: string;
  upstreams: string[];
  stripPrefix: boolean;
  authRequired: boolean;
  requiredPermission: string | null;
  requireSignature: boolean;
}

export interface IpRuleConfig {
  cidr: string;
  action: "allow" | "deny";
  priority: number;
}

export interface GatewayConfig {
  jwtSecret: string;
  roles: Record<string, RoleConfig>;
  apiKeys: ApiKeyConfig[];
  routes: RouteConfig[];
  ipRules: IpRuleConfig[];
}

export function emptyConfig(): GatewayConfig {
  return { jwtSecret: "", roles: {}, apiKeys: [], routes: [], ipRules: [] };
}
