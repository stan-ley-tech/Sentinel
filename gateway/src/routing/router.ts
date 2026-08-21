// Path-prefix routing over the current config: longest-prefix-match picks
// the most specific route, then round-robins over whichever of its
// upstreams are currently healthy.

import type { GatewayConfig, RouteConfig } from "../config/types.js";

function matchesPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return pathname.startsWith(normalized);
}

export class Router {
  private readonly roundRobinCounters = new Map<string, number>();

  constructor(
    private readonly getConfig: () => GatewayConfig,
    private readonly isHealthy: (upstream: string) => boolean = () => true,
  ) {}

  /** Returns the most specific route matching pathname, or null. */
  match(pathname: string): RouteConfig | null {
    const candidates = this.getConfig().routes.filter((r) => matchesPrefix(pathname, r.pathPrefix));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
    return candidates[0] ?? null;
  }

  /** Round-robins over route's healthy upstreams; null if none are healthy. */
  pickUpstream(route: RouteConfig): string | null {
    const healthy = route.upstreams.filter((u) => this.isHealthy(u));
    if (healthy.length === 0) return null;
    const counter = this.roundRobinCounters.get(route.id) ?? 0;
    const upstream = healthy[counter % healthy.length];
    this.roundRobinCounters.set(route.id, counter + 1);
    return upstream ?? null;
  }

  /** Builds the path+query to forward to the upstream, stripping the
   * matched prefix when the route is configured to. */
  buildForwardPath(route: RouteConfig, pathname: string, search: string): string {
    if (!route.stripPrefix) return pathname + search;
    let remainder = pathname.slice(route.pathPrefix.length);
    if (!remainder.startsWith("/")) remainder = `/${remainder}`;
    return remainder + search;
  }
}
