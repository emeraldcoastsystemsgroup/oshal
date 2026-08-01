/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | K5 guard (BACKLOG kernel audit 2026-07-29): worker bots inherited the SUPERUSER database URL while the api ran least-privilege oshal_app — and Postgres exempts superuser/BYPASSRLS roles from row-level security, so every bot node was an RLS bypass around the per-user isolation the platform is sold on. This spec pins the whole fix: (1) no compose DATABASE_URL defaults to the superuser `oshal` role; (2) bots read their OWN interpolation var (BOT_DATABASE_URL) so a legacy .env pointing DATABASE_URL at the superuser can never leak back into bot containers — exactly ONE `${DATABASE_URL:-…}` remains, the api's oshal_app runtime DSN; (3) migration 099 creates oshal_bot NOSUPERUSER+NOBYPASSRLS+NOCREATEROLE, grants DML only, and never grants ownership — the attributes that make RLS actually enforce on a bot-path connection. The remaining live leg (two-user RLS test with bots up) is a deploy-time step recorded in the BACKLOG.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const compose = fs.readFileSync(path.resolve(process.cwd(), 'docker-compose.oshal-local.yml'), 'utf8');
const migration = fs.readFileSync(path.resolve(process.cwd(), 'scripts/migrations/099-bot-db-role.sql'), 'utf8');

describe('K5: bot containers never get a superuser DSN (RLS bypass)', () => {
  it('no runtime DATABASE_URL in the deployment compose defaults to the superuser role', () => {
    // BOOTSTRAP_DATABASE_URL (the api's migration/provisioning leg) is the one sanctioned
    // superuser slot; the ^DATABASE_URL key match excludes it by name.
    const offenders = compose
      .split('\n')
      .filter((line) => /^\s*DATABASE_URL:/.test(line) && line.includes('postgresql://oshal:oshal@'));
    expect(
      offenders,
      'a compose service defaults its runtime DATABASE_URL to the SUPERUSER `oshal` role — '
        + 'Postgres exempts superusers from RLS, so this hands the container a bypass around '
        + 'per-user isolation (K5). Bot services default to oshal_bot; the api to oshal_app.',
    ).toEqual([]);
  });

  it('bots read BOT_DATABASE_URL — the api DSN is the ONLY ${DATABASE_URL:-…} interpolation left', () => {
    // The inheritance itself was the defect: bots followed the operator's DATABASE_URL, which on
    // legacy .envs was the superuser. If a bot service reads ${DATABASE_URL:-…} again this count
    // grows past 1 and the guard goes red.
    const inherited = compose.match(/DATABASE_URL: \$\{DATABASE_URL:-/g) ?? [];
    expect(inherited.length, 'bot services must interpolate BOT_DATABASE_URL, never DATABASE_URL').toBe(1);
    // And that one survivor is the api's least-privilege app-role default, not a superuser.
    expect(compose).toContain('DATABASE_URL: ${DATABASE_URL:-postgresql://oshal_app:');
    // The bot default itself points at the scoped role.
    expect(compose).toContain('DATABASE_URL: ${BOT_DATABASE_URL:-postgresql://oshal_bot:');
  });

  it('migration 099 shapes oshal_bot so RLS enforces: NOSUPERUSER, NOBYPASSRLS, no DDL, no ownership', () => {
    expect(migration).toMatch(/CREATE ROLE oshal_bot LOGIN/);
    expect(migration).toMatch(/NOSUPERUSER/);
    expect(migration).toMatch(/NOCREATEROLE/);
    expect(migration).toMatch(/NOCREATEDB/);
    // Every BYPASSRLS mention must be the NO-prefixed attribute — a bare BYPASSRLS anywhere
    // in this file would quietly recreate the K5 bypass under a new role name.
    expect(migration).not.toMatch(/(?<!NO)BYPASSRLS/);
    // DML only: the role owns nothing (ownership would exempt it from non-FORCE RLS) and
    // gets no DDL grant beyond schema USAGE.
    expect(migration).not.toMatch(/OWNER TO oshal_bot/i);
    expect(migration).not.toMatch(/GRANT (ALL|CREATE)[^\n]*TO oshal_bot/i);
    expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oshal_bot/);
  });

  it('the defensive converge keeps a pre-existing role least-privilege too', () => {
    // If the role already exists (re-run, hand-provisioned), the migration must still strip
    // any drifted attributes rather than trusting them.
    expect(migration).toMatch(/ALTER ROLE oshal_bot NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE/);
  });
});
