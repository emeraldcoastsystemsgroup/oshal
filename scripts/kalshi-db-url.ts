/**
 * Host-side Postgres URL for the Kalshi research scripts.
 *
 * `.env`'s DATABASE_URL names the DOCKER-INTERNAL host (`oshal-db:5432`), which does not resolve
 * from a process running on the Windows host — so a scheduled task using it fails silently every
 * morning, which is the worst kind of failure for an unattended research loop. When the URL points
 * at the in-compose hostname and we are NOT inside the compose network, rewrite it to the
 * published host port. Explicit and logged; no silent magic.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — host-vs-container DB URL resolution so the scheduled forward test can actually reach Postgres.
 */

/** Published host port for oshal-local-db (docker-compose maps 5432 → 55433). */
const HOST_PORT = process.env.OSHAL_DB_HOST_PORT || '55433';

/**
 * @description The DATABASE_URL to use from a HOST-side script. Rewrites the compose-internal
 * hostname to 127.0.0.1:<published port> unless we're running inside the compose network.
 * @returns A connectable Postgres URL.
 */
export function hostDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) throw new Error('DATABASE_URL is not set');
  // Inside a container the compose hostname resolves — leave it alone.
  if (process.env.BOT_RUNTIME || process.env.IN_DOCKER === 'true') return raw;
  try {
    const u = new URL(raw);
    if (u.hostname === 'oshal-db' || u.hostname === 'oshal-local-db') {
      u.hostname = '127.0.0.1';
      u.port = HOST_PORT;
      return u.toString();
    }
  } catch {
    /* not a parseable URL — hand it back untouched and let pg report the real error */
  }
  return raw;
}
