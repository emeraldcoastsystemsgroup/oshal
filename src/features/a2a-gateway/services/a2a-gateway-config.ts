/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Env knobs for the inbound A2A gateway: A2A_GATEWAY_ENABLED (default OFF — the entire surface 404s so an unconfigured deployment exposes nothing) and A2A_MAX_INBOUND_PER_HOUR (default 20 tickets/agent/hour, garbage-tolerant like the budget runaway knobs).
 */

/**
 * @description Whether the inbound A2A gateway surface (well-known card + JSON-RPC
 * endpoint) is live. Default is OFF: unless the operator explicitly sets
 * A2A_GATEWAY_ENABLED=true, both routes answer 404 so nothing about the swarm is
 * discoverable — the safe posture for a public-by-default Express app.
 * @param env - Environment bag (injectable for tests; defaults to process.env).
 * @returns True only when the operator has explicitly enabled the gateway.
 */
export function isA2aGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.A2A_GATEWAY_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/** Default per-agent inbound ticket ceiling per rolling hour. */
const DEFAULT_MAX_INBOUND_PER_HOUR = 20;

/**
 * @description Per-agent inbound task ceiling (tickets filed per rolling hour), read
 * from A2A_MAX_INBOUND_PER_HOUR. Garbage/zero/negative values fall back to the default
 * so a typo can never yield an unlimited (or NaN) ceiling.
 * @param env - Environment bag (injectable for tests; defaults to process.env).
 * @returns The positive integer ceiling.
 */
export function readMaxInboundPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.A2A_MAX_INBOUND_PER_HOUR ?? DEFAULT_MAX_INBOUND_PER_HOUR);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_INBOUND_PER_HOUR;
  return Math.floor(raw);
}
