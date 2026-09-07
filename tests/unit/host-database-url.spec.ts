/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the host-side DATABASE_URL resolution the Playwright webServer depends on. The defect it prevents is silent: a compose-internal host does not resolve off-container, the managed server boots DB-less, and every database-backed e2e SKIPS — a green run that proved nothing. Cases pin both directions (rewrite off-container, never rewrite inside one), the published-port convention, and the refusals that keep it from inventing a connection.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUBLISHED_PG_PORT,
  hostReachableDatabaseUrl,
  runningInsideContainer,
} from '../helpers/host-database-url';

const COMPOSE_DSN = 'postgresql://oshal:secret@oshal-db:5432/oshal';

describe('hostReachableDatabaseUrl — a host-side run must actually reach Postgres', () => {
  it('rewrites a compose service host to the published loopback port', () => {
    const out = hostReachableDatabaseUrl(COMPOSE_DSN, {}, false);
    expect(out).toBe(`postgresql://oshal:secret@127.0.0.1:${DEFAULT_PUBLISHED_PG_PORT}/oshal`);
  });

  it('honours OSHAL_PG_PORT — the same knob the compose mapping and the DB-backed specs use', () => {
    expect(hostReachableDatabaseUrl(COMPOSE_DSN, { OSHAL_PG_PORT: '55999' }, false))
      .toBe('postgresql://oshal:secret@127.0.0.1:55999/oshal');
  });

  it('leaves the value alone INSIDE a container, where the compose host is the right answer', () => {
    expect(hostReachableDatabaseUrl(COMPOSE_DSN, {}, true)).toBe(COMPOSE_DSN);
  });

  it('leaves a loopback host alone rather than re-pointing a deliberate port', () => {
    for (const dsn of [
      'postgresql://oshal:secret@127.0.0.1:5432/oshal',
      'postgresql://oshal:secret@localhost:5432/oshal',
    ]) {
      expect(hostReachableDatabaseUrl(dsn, {}, false)).toBe(dsn);
    }
  });

  it('never invents a connection: an unset value stays unset, a non-URL DSN is untouched', () => {
    expect(hostReachableDatabaseUrl(undefined, {}, false)).toBeUndefined();
    expect(hostReachableDatabaseUrl('', {}, false)).toBeUndefined();
    const keyValueDsn = 'host=oshal-db port=5432 dbname=oshal';
    expect(hostReachableDatabaseUrl(keyValueDsn, {}, false)).toBe(keyValueDsn);
  });

  it('detects the container marker through the injected probe', () => {
    expect(runningInsideContainer((p) => p === '/.dockerenv')).toBe(true);
    expect(runningInsideContainer(() => false)).toBe(false);
  });
});
