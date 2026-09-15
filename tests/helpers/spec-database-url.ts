/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Resolve the database a DESTRUCTIVE spec connects to, and REFUSE when nothing pointed it anywhere. 23 DB-backed specs ended their DSN expression in a hardcoded loopback fallback built from the compose published-port knob, and that port is the operator LIVE trading Postgres — so `npx vitest run tests/unit/trading-*.spec.ts` with no environment variable set created and dropped schema, and wrote order rows (some tagged mode=live), in production. It fired twice on 2026-09-14 from two lanes that had each been told in writing not to touch that database, and left 24 orphan spec-* rows in oshal_trading_books accumulating since 2026-09-07. A brief is not a guard; the DEFAULT had to change. This resolver has no default: unpointed throws and names the variables that would have answered, and a DSN that lands ON the live published port throws unless the run says out loud that it meant it. The published-port constant is imported from host-database-url.ts rather than restated — that module rewrites a compose DSN for a HOST-side Playwright run, which is a legitimate read-mostly use of the published port, and it is deliberately left byte-identical.
 */

import { DEFAULT_PUBLISHED_PG_PORT } from './host-database-url';

/** Hosts that mean "this machine" — where the published live-stack port is reachable. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * The one acknowledgement that lets a destructive spec run against the live stack's published
 * Postgres. It exists so the answer to the refusal is a deliberate, greppable act rather than an
 * edit to this file; nothing in the repo sets it.
 */
export const LIVE_STACK_ACKNOWLEDGEMENT = 'OSHAL_ALLOW_LIVE_STACK_DB';

/**
 * @description Whether a connection string points at the live stack's published Postgres — the
 * operator's real database. Compares the parsed host and port rather than matching text, so
 * `localhost`, `::1` and an explicit `?host=` spelling are all caught.
 * @param dsn - The resolved connection string.
 * @param publishedPort - The published port to test against (defaults to the compose mapping's).
 * @returns True when the DSN would connect to the live stack's published Postgres.
 */
export function pointsAtLiveStack(dsn: string, publishedPort: string = DEFAULT_PUBLISHED_PG_PORT): boolean {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return false; // A libpq key/value DSN — not a shape this resolver produces or can judge.
  }
  return LOOPBACK_HOSTS.has(url.hostname) && url.port === publishedPort;
}

/**
 * @description Resolve the database a destructive spec should connect to from the environment
 * variables that spec supports, in the order given. There is no fallback: when none of them is
 * set the call THROWS and names every variable that would have answered, because the value a
 * silent fallback used to produce was the operator's live trading database. A resolved value that
 * lands on the live stack's published port is refused the same way unless the run sets
 * `OSHAL_ALLOW_LIVE_STACK_DB=1`, which is the deliberate escape hatch for the rare case where
 * running against the deployment really is what was meant.
 * @param vars - Environment variable names this spec accepts, most specific first.
 * @param env - Environment to read (injectable so the guard can exercise both outcomes).
 * @returns The connection string the spec must use.
 * @throws When no variable is set, or when the resolved DSN is the live stack without acknowledgement.
 */
export function specDatabaseUrl(vars: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  if (vars.length === 0) throw new Error('specDatabaseUrl needs at least one environment variable name');
  const resolved = vars.map((name) => [name, env[name]] as const).find(([, value]) => Boolean(value));
  if (!resolved) {
    throw new Error(
      `This spec writes to and drops schema in whatever database it is given, so it has no default: ` +
      `set ${vars.join(' or ')} to a DISPOSABLE PostgreSQL before running it. ` +
      `Do NOT point it at the live stack (127.0.0.1:${DEFAULT_PUBLISHED_PG_PORT}) — that is the ` +
      `operator's real trading database. A throwaway is one command: ` +
      `docker run -d --rm -p 127.0.0.1:0:5432 -e POSTGRES_PASSWORD=spec -e POSTGRES_USER=oshal ` +
      `-e POSTGRES_DB=oshal pgvector/pgvector:pg16 (see tests/helpers/disposable-alert-postgres.ts ` +
      `for the same idea wired into a fixture).`,
    );
  }
  const [name, value] = resolved as readonly [string, string];
  if (pointsAtLiveStack(value) && env[LIVE_STACK_ACKNOWLEDGEMENT] !== '1') {
    throw new Error(
      `${name} points at 127.0.0.1:${DEFAULT_PUBLISHED_PG_PORT}, the LIVE stack's published ` +
      `Postgres — the operator's real trading database — and this spec creates and destroys data. ` +
      `Point it at a disposable PostgreSQL, or set ${LIVE_STACK_ACKNOWLEDGEMENT}=1 if running ` +
      `against the deployment is genuinely what you meant.`,
    );
  }
  return value;
}

/**
 * @description The `host:port` of the database resolved by {@link specDatabaseUrl}, for a spec that
 * has to mint a SECOND connection string against the same cluster under a different role. It exists
 * so those specs derive the address from the one resolved DSN instead of re-typing a host and port,
 * which is how the published-port literal spread to 23 files in the first place.
 * @param vars - Environment variable names this spec accepts, most specific first.
 * @param env - Environment to read.
 * @returns The authority (`host:port`) of the resolved connection string.
 * @throws Everything {@link specDatabaseUrl} throws, plus when the resolved value is not a URL.
 */
export function specDatabaseHost(vars: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const dsn = specDatabaseUrl(vars, env);
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error(`${vars.join('/')} must be a URL-shaped DSN for this spec — it derives a second role's DSN from its host and port.`);
  }
  return url.host;
}
