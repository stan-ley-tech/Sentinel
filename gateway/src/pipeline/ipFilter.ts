// IP allow/deny enforcement over IPv4 CIDRs. Policy: any matching deny
// rule rejects outright; if any allow rules are configured, the request
// must match at least one of them; with no allow rules at all, traffic is
// allowed by default (deny-list-only mode, the common case).

import { isIPv4 } from "node:net";

import type { IpRuleConfig } from "../config/types.js";
import type { Rejection } from "./context.js";

function ipToInt(ip: string): number | null {
  if (!isIPv4(ip)) return null;
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  const [a, b, c, d] = octets as [number, number, number, number];
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function cidrMatches(ip: string, cidr: string): boolean {
  const [network, bitsStr] = cidr.split("/");
  if (network === undefined) return false;
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const ipInt = ipToInt(ip);
  const networkInt = ipToInt(network);
  if (ipInt === null || networkInt === null) return false;

  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (networkInt & mask);
}

export function checkIpRules(clientIp: string, rules: IpRuleConfig[]): Rejection | null {
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);

  for (const rule of sorted) {
    if (rule.action === "deny" && cidrMatches(clientIp, rule.cidr)) {
      return { statusCode: 403, error: "IP address denied" };
    }
  }

  const allowRules = sorted.filter((r) => r.action === "allow");
  if (allowRules.length === 0) return null;

  const allowed = allowRules.some((r) => cidrMatches(clientIp, r.cidr));
  return allowed ? null : { statusCode: 403, error: "IP address not in allow list" };
}
