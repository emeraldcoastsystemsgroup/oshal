/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D2: barrel for the route auth-mode contract.
 */

export {
  ROUTE_AUTH_MODES,
  DEFAULT_ROUTE_AUTH_MODE,
  isRouteAuthMode,
  resolveRouteAuthMode,
  routeAuthContradicts,
  type SwarmAppRouteAuthMode,
  type RouteAuthDeclaration,
} from './registry';
