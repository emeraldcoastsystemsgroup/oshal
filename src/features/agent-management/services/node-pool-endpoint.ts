/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added node-id and endpoint trust validation so Redis registry data cannot redirect credential-bearing node assignments to an arbitrary SSRF target or inject Redis key segments/prototype properties.
 */

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * @description Validates a node id before it becomes part of a Redis key or an
 * in-memory object key. Colons, path separators, dots, and prototype sentinels
 * are intentionally excluded.
 * @param nodeId - Candidate pool node identifier.
 * @returns The unchanged validated identifier.
 */
export function requireSafeNodeId(nodeId: string): string {
  if (!NODE_ID_PATTERN.test(nodeId) || ['constructor', 'prototype'].includes(nodeId.toLowerCase())) {
    throw new Error('Invalid node id');
  }
  return nodeId;
}

/**
 * @description Normalizes endpoints supplied directly to the allocator constructor.
 * Constructor configuration is an operator-controlled trust root, but URL credentials,
 * non-HTTP schemes, and path/query fragments remain invalid.
 * @param nodeId - Node id paired with the configured endpoint.
 * @param endpoint - Operator-configured endpoint origin.
 * @returns Canonical origin without a trailing slash.
 */
export function normalizeConfiguredNodeEndpoint(nodeId: string, endpoint: string): string {
  requireSafeNodeId(nodeId);
  return normalizeEndpoint(endpoint);
}

/**
 * @description Validates an endpoint learned from the mutable Redis node registry.
 * Its hostname must equal the node id (the Docker-DNS convention) or appear in the
 * explicit NODE_POOL_ALLOWED_HOSTS allowlist. This stops poisoned registry data from
 * receiving the provider credentials carried by POST /node/assign.
 * @param nodeId - Validated node identity expected at the endpoint.
 * @param endpoint - Registry-provided endpoint URL.
 * @returns Canonical trusted endpoint origin.
 */
export function normalizeRegisteredNodeEndpoint(nodeId: string, endpoint: string): string {
  const safeNodeId = requireSafeNodeId(nodeId);
  const normalized = normalizeEndpoint(endpoint);
  const hostname = new URL(normalized).hostname.toLowerCase();
  const allowedHosts = registeredHostAllowlist(safeNodeId);
  if (!allowedHosts.has(hostname)) throw new Error('Untrusted node endpoint host');
  return normalized;
}

function normalizeEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('Invalid node endpoint');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid node endpoint protocol');
  if (parsed.username || parsed.password) throw new Error('Node endpoint must not contain credentials');
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('Node endpoint must be an origin');
  }
  return parsed.origin;
}

function registeredHostAllowlist(nodeId: string): Set<string> {
  const configured = String(process.env.NODE_POOL_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return new Set([nodeId.toLowerCase(), ...configured]);
}
