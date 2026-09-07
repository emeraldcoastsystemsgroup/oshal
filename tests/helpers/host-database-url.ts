/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Resolve a compose-internal DATABASE_URL to the published loopback port so a HOST-side run can reach Postgres. `.env` names the compose service host (`oshal-db:5432`) because that is what the containers use; from the machine running Playwright it is ENOTFOUND, so the managed server booted DB-less — `/api/swarm/apps` answered "timeout exceeded when trying to connect" and every database-backed e2e skipped or failed, which is indistinguishable from a passing run. Uses the SAME published-port convention the DB-backed unit specs already carry (`OSHAL_PG_PORT`, default 55433 — the compose mapping's own default), so there is no second source of truth.
 */

import fs from 'fs';

/** Hosts that are already reachable from the machine running the tests. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** The port docker-compose publishes Postgres on, matching `${OSHAL_PG_PORT:-55433}` in the compose file. */
export const DEFAULT_PUBLISHED_PG_PORT = '55433';

/**
 * @description Whether this process is running INSIDE a container, where the compose service
 * hostnames resolve and no rewrite is wanted. Injectable so the guard can exercise both worlds
 * without pretending the test host is something it is not.
 * @param exists - Filesystem probe (defaults to the real `fs.existsSync`).
 * @returns True when the Docker container marker is present.
 */
export function runningInsideContainer(exists: (p: string) => boolean = fs.existsSync): boolean {
  return exists('/.dockerenv');
}

/**
 * @description Rewrite a connection string whose host is a compose service name so a host-side
 * process can reach the same database through the published loopback port. Returns the input
 * unchanged when there is nothing to correct: inside a container, for a loopback host, or for a
 * value that is not a URL at all. It never invents a connection string — a missing DATABASE_URL
 * stays missing, so a misconfigured run still fails loudly instead of silently pointing somewhere.
 * @param raw - The configured DATABASE_URL (typically from `.env`).
 * @param env - Environment used to resolve the published port (`OSHAL_PG_PORT`).
 * @param inContainer - Whether this process runs inside a container; defaults to a real probe.
 * @returns A host-reachable connection string, or undefined when `raw` is empty.
 */
export function hostReachableDatabaseUrl(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  inContainer: boolean = runningInsideContainer(),
): string | undefined {
  if (!raw) return undefined;
  if (inContainer) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // A libpq key/value DSN or similar — leave it exactly as configured.
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) return raw;
  url.hostname = '127.0.0.1';
  url.port = String(env.OSHAL_PG_PORT ?? DEFAULT_PUBLISHED_PG_PORT);
  return url.toString();
}
