// Polls the control plane's /internal/config snapshot and hot-reloads the
// gateway's in-memory policy — no restart needed to pick up a new API key,
// route, or IP rule. If the control plane is briefly unreachable, the
// gateway keeps serving traffic against whatever config it last fetched
// successfully; it only serves an empty (all-404) config before the very
// first successful fetch.

import { emptyConfig, type ApiKeyConfig, type GatewayConfig, type IpRuleConfig, type RouteConfig } from "./types.js";

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`config: expected string for ${field}`);
  return value;
}

function asStringOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, field);
}

function asNumberOrNull(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number") throw new Error(`config: expected number for ${field}`);
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`config: expected boolean for ${field}`);
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`config: expected string array for ${field}`);
  }
  return value as string[];
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`config: expected object for ${field}`);
  }
  return value as Record<string, unknown>;
}

function parseApiKey(raw: unknown): ApiKeyConfig {
  const r = asRecord(raw, "api_keys[]");
  const quotaPeriod = asStringOrNull(r.quota_period, "api_keys[].quota_period");
  if (quotaPeriod !== null && quotaPeriod !== "day" && quotaPeriod !== "month") {
    throw new Error(`config: invalid api_keys[].quota_period '${quotaPeriod}'`);
  }
  return {
    id: asString(r.id, "api_keys[].id"),
    keyHash: asString(r.key_hash, "api_keys[].key_hash"),
    role: asString(r.role, "api_keys[].role"),
    signingSecret: asString(r.signing_secret, "api_keys[].signing_secret"),
    enabled: asBoolean(r.enabled, "api_keys[].enabled"),
    rateLimitPerSecond: asNumberOrNull(r.rate_limit_per_second, "api_keys[].rate_limit_per_second"),
    rateLimitBurst: asNumberOrNull(r.rate_limit_burst, "api_keys[].rate_limit_burst"),
    quotaLimit: asNumberOrNull(r.quota_limit, "api_keys[].quota_limit"),
    quotaPeriod,
  };
}

function parseRoute(raw: unknown): RouteConfig {
  const r = asRecord(raw, "routes[]");
  return {
    id: asString(r.id, "routes[].id"),
    pathPrefix: asString(r.path_prefix, "routes[].path_prefix"),
    upstreams: asStringArray(r.upstreams, "routes[].upstreams"),
    stripPrefix: asBoolean(r.strip_prefix, "routes[].strip_prefix"),
    authRequired: asBoolean(r.auth_required, "routes[].auth_required"),
    requiredPermission: asStringOrNull(r.required_permission, "routes[].required_permission"),
    requireSignature: asBoolean(r.require_signature, "routes[].require_signature"),
  };
}

function parseIpRule(raw: unknown): IpRuleConfig {
  const r = asRecord(raw, "ip_rules[]");
  const action = asString(r.action, "ip_rules[].action");
  if (action !== "allow" && action !== "deny") {
    throw new Error(`config: invalid ip_rules[].action '${action}'`);
  }
  return {
    cidr: asString(r.cidr, "ip_rules[].cidr"),
    action,
    priority: asNumberOrNull(r.priority, "ip_rules[].priority") ?? 0,
  };
}

export function parseConfig(raw: unknown): GatewayConfig {
  const obj = asRecord(raw, "<root>");
  const rolesRaw = asRecord(obj.roles, "roles");

  const roles: GatewayConfig["roles"] = {};
  for (const [name, value] of Object.entries(rolesRaw)) {
    roles[name] = { permissions: asStringArray(value, `roles.${name}`) };
  }

  if (!Array.isArray(obj.api_keys)) throw new Error("config: api_keys must be an array");
  if (!Array.isArray(obj.routes)) throw new Error("config: routes must be an array");
  if (!Array.isArray(obj.ip_rules)) throw new Error("config: ip_rules must be an array");

  return {
    jwtSecret: asString(obj.jwt_secret, "jwt_secret"),
    roles,
    apiKeys: obj.api_keys.map(parseApiKey),
    routes: obj.routes.map(parseRoute),
    ipRules: obj.ip_rules.map(parseIpRule),
  };
}

export class ConfigClient {
  private current: GatewayConfig = emptyConfig();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly controlPlaneUrl: string,
    private readonly internalToken: string,
    private readonly pollIntervalMs: number = 5000,
  ) {}

  get config(): GatewayConfig {
    return this.current;
  }

  async start(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      console.error("sentinel gateway: initial config fetch failed, starting with an empty config:", err);
    }
    this.timer = setInterval(() => {
      this.refresh().catch((err) => console.error("sentinel gateway: config refresh failed:", err));
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<void> {
    const res = await fetch(`${this.controlPlaneUrl}/internal/config`, {
      headers: { Authorization: `Bearer ${this.internalToken}` },
    });
    if (!res.ok) {
      throw new Error(`config fetch failed: HTTP ${res.status}`);
    }
    const raw: unknown = await res.json();
    this.current = parseConfig(raw);
  }
}
