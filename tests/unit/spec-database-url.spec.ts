/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the resolver that replaced the DB-backed specs' silent default. The behaviour that matters is the REFUSAL: an unpointed run must throw and name the variables that would have answered, because the value it used to invent was the operator's live trading Postgres, and a spec that resolves it silently creates and destroys production data with nothing warning. Also pins the second wall — a DSN that lands ON the live published port is refused unless the run acknowledges it — and the pass-through and precedence cases, so the refusal cannot be "fixed" later by making everything throw. The published port is imported, never typed: a literal here would be a hit for the gate this file's sibling proves.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLISHED_PG_PORT } from '../helpers/host-database-url';
import {
  LIVE_STACK_ACKNOWLEDGEMENT,
  pointsAtLiveStack,
  specDatabaseHost,
  specDatabaseUrl,
} from '../helpers/spec-database-url';

const LIVE = `postgresql://oshal:oshal@127.0.0.1:${DEFAULT_PUBLISHED_PG_PORT}/oshal`;
const DISPOSABLE = 'postgresql://oshal:spec@127.0.0.1:49999/oshal';

describe('specDatabaseUrl — an unpointed destructive spec REFUSES rather than resolving', () => {
  it('throws when no variable is set, instead of inventing a connection string', () => {
    expect(() => specDatabaseUrl(['MY_TEST_DSN'], {})).toThrow();
  });

  it('names every variable that would have answered, in the order the spec accepts them', () => {
    let message = '';
    try { specDatabaseUrl(['FIRST_TEST_DSN', 'SECOND_TEST_DSN'], {}); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('FIRST_TEST_DSN');
    expect(message).toContain('SECOND_TEST_DSN');
    expect(message.indexOf('FIRST_TEST_DSN')).toBeLessThan(message.indexOf('SECOND_TEST_DSN'));
  });

  it('the refusal says the database must be DISPOSABLE and warns off the live stack by address', () => {
    let message = '';
    try { specDatabaseUrl(['MY_TEST_DSN'], {}); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/DISPOSABLE/);
    expect(message).toContain(`127.0.0.1:${DEFAULT_PUBLISHED_PG_PORT}`);
  });

  it('an empty value is not an answer — it refuses rather than connecting to the empty string', () => {
    expect(() => specDatabaseUrl(['MY_TEST_DSN'], { MY_TEST_DSN: '' })).toThrow();
  });

  it('refuses a call that supplies no variable names at all', () => {
    expect(() => specDatabaseUrl([], { MY_TEST_DSN: DISPOSABLE })).toThrow(/at least one/);
  });
});

describe('specDatabaseUrl — a database the run named is returned unchanged', () => {
  it('returns the first variable that is set, byte for byte', () => {
    expect(specDatabaseUrl(['MY_TEST_DSN'], { MY_TEST_DSN: DISPOSABLE })).toBe(DISPOSABLE);
  });

  it('honours precedence: the most specific variable wins over the general one', () => {
    const env = { FIRST_TEST_DSN: DISPOSABLE, SECOND_TEST_DSN: 'postgresql://oshal:spec@127.0.0.1:49998/oshal' };
    expect(specDatabaseUrl(['FIRST_TEST_DSN', 'SECOND_TEST_DSN'], env)).toBe(DISPOSABLE);
  });

  it('falls through a variable that is unset to the next one the spec accepts', () => {
    expect(specDatabaseUrl(['FIRST_TEST_DSN', 'SECOND_TEST_DSN'], { SECOND_TEST_DSN: DISPOSABLE })).toBe(DISPOSABLE);
  });

  it('does not require a URL shape — a libpq key/value DSN passes through', () => {
    const kv = 'host=/var/run/postgresql dbname=oshal';
    expect(specDatabaseUrl(['MY_TEST_DSN'], { MY_TEST_DSN: kv })).toBe(kv);
  });
});

describe('specDatabaseUrl — the live stack is refused even when named explicitly', () => {
  it('throws when the resolved DSN is the live stack, and names the variable that pointed there', () => {
    let message = '';
    try { specDatabaseUrl(['MY_TEST_DSN'], { MY_TEST_DSN: LIVE }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('MY_TEST_DSN');
    expect(message).toContain(LIVE_STACK_ACKNOWLEDGEMENT);
    expect(message).toMatch(/trading database/);
  });

  it('allows it when the run acknowledges the live stack out loud', () => {
    const env = { MY_TEST_DSN: LIVE, [LIVE_STACK_ACKNOWLEDGEMENT]: '1' };
    expect(specDatabaseUrl(['MY_TEST_DSN'], env)).toBe(LIVE);
  });

  it('an acknowledgement that is merely PRESENT is not enough — it must be 1', () => {
    const env = { MY_TEST_DSN: LIVE, [LIVE_STACK_ACKNOWLEDGEMENT]: 'true' };
    expect(() => specDatabaseUrl(['MY_TEST_DSN'], env)).toThrow();
  });
});

describe('pointsAtLiveStack — the published port on any spelling of this machine', () => {
  it('recognises the loopback spellings a DSN can carry', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(pointsAtLiveStack(`postgresql://u:p@${host}:${DEFAULT_PUBLISHED_PG_PORT}/oshal`), host).toBe(true);
    }
  });

  it('does not fire on another port, another host, or a DSN it cannot parse', () => {
    expect(pointsAtLiveStack(DISPOSABLE)).toBe(false);
    expect(pointsAtLiveStack(`postgresql://u:p@db.internal:${DEFAULT_PUBLISHED_PG_PORT}/oshal`)).toBe(false);
    expect(pointsAtLiveStack('host=/var/run/postgresql dbname=oshal')).toBe(false);
  });
});

describe('specDatabaseHost — a second role connects to the SAME cluster the run named', () => {
  it('derives host:port from the resolved DSN', () => {
    expect(specDatabaseHost(['MY_TEST_DSN'], { MY_TEST_DSN: DISPOSABLE })).toBe('127.0.0.1:49999');
  });

  it('refuses an unpointed run exactly like the resolver it is built on', () => {
    expect(() => specDatabaseHost(['MY_TEST_DSN'], {})).toThrow(/MY_TEST_DSN/);
  });

  it('refuses the live stack without acknowledgement, so a derived DSN cannot smuggle it in', () => {
    expect(() => specDatabaseHost(['MY_TEST_DSN'], { MY_TEST_DSN: LIVE })).toThrow(LIVE_STACK_ACKNOWLEDGEMENT);
  });

  it('says so when the value it was given has no host to derive', () => {
    const env = { MY_TEST_DSN: 'host=/var/run/postgresql dbname=oshal' };
    expect(() => specDatabaseHost(['MY_TEST_DSN'], env)).toThrow(/URL-shaped/);
  });
});
