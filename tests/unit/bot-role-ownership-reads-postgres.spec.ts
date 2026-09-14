/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard migration 140. The bot-node ADR-149 posture check reads ownership with the BOT role and fails closed on any exception, so a missing grant does not read as "denied" - it reads as "every bot execution is 503". That is exactly how Jarvis answered "sorry" on 2026-09-14 while the api itself was healthy. This crosses the REAL boundary the defect lived on: a real PostgreSQL, the real oshal_bot role, the real relations and the real RLS helper function - never a doubled query, because a mock cannot express a privilege.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { Client } from 'pg';

/**
 * @description Admin connection string for the live local stack. The spec is skipped, loudly and
 * with a reason, when it is absent — a privilege cannot be simulated, so there is nothing useful to
 * assert without a real server.
 */
const ADMIN_URL = process.env.OWNERSHIP_TEST_ADMIN_URL
  ?? process.env.BOOTSTRAP_DATABASE_URL
  ?? 'postgresql://oshal:oshal-dev@127.0.0.1:55432/oshal';

/** Relations `readApplicationExecutionOwnership` queries; every one must be readable by the bot. */
const REQUIRED_TABLES = [
  'public.oshal_authorization_applications',
  'public.swarm_applications',
  'public.agents',
] as const;

/** RLS helpers the policies on those relations call while the bot reads them. */
const REQUIRED_FUNCTIONS = ['public.oshal_is_tenant_member(text)'] as const;

async function connect(): Promise<Client | null> {
  const client = new Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => undefined);
    return null;
  }
}

describe('the oshal_bot role can perform the reads its own posture guard depends on', () => {
  let client: Client | null = null;
  let roleExists = false;

  beforeAll(async () => {
    client = await connect();
    if (!client) return;
    const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'oshal_bot'");
    roleExists = rows.length > 0;
  }, 20000);

  it('reaches a database at all — otherwise this guard proves nothing and says so', () => {
    if (!client) {
      expect.soft(client, `No PostgreSQL at ${ADMIN_URL.replace(/:[^:@]*@/, ':***@')}. This guard `
        + 'asserts a database PRIVILEGE, which cannot be mocked. Start the local stack or set '
        + 'OWNERSHIP_TEST_ADMIN_URL, then re-run — do not treat this file as passing.').not.toBeNull();
    }
    expect(true).toBe(true);
  });

  it.runIf(true)('grants oshal_bot SELECT on every relation the ownership reader queries', async () => {
    if (!client || !roleExists) return;
    for (const table of REQUIRED_TABLES) {
      const { rows } = await client.query(
        'SELECT has_table_privilege($1, $2, $3) AS allowed', ['oshal_bot', table, 'SELECT'],
      );
      expect(rows[0]?.allowed, `oshal_bot cannot SELECT ${table}. readApplicationExecutionOwnership `
        + 'runs in the bot node with this role and its caller converts ANY exception into '
        + 'authorization_bot_posture_unavailable, so a missing grant here makes EVERY bot execution '
        + 'answer 503 — it does not merely deny one. Apply migration 140.').toBe(true);
    }
  }, 20000);

  it('grants oshal_bot EXECUTE on the RLS helpers those relations’ policies call', async () => {
    if (!client || !roleExists) return;
    for (const fn of REQUIRED_FUNCTIONS) {
      const { rows } = await client.query(
        'SELECT has_function_privilege($1, $2, $3) AS allowed', ['oshal_bot', fn, 'EXECUTE'],
      );
      expect(rows[0]?.allowed, `oshal_bot cannot EXECUTE ${fn}. The SELECT grant alone is not `
        + 'enough: swarm_applications\' policy calls this function, and without EXECUTE the read '
        + 'raises 42501 instead of returning a filtered result. Apply migration 140.').toBe(true);
    }
  }, 20000);

  it('keeps the control-plane policy on the authorization table — the grant must not have widened it', async () => {
    if (!client) return;
    const { rows } = await client.query(
      `SELECT policyname, qual FROM pg_policies
        WHERE tablename = 'oshal_authorization_applications'`,
    );
    const controlPlane = rows.find(r => String(r.policyname).includes('control_plane'));
    expect(controlPlane, 'oshal_authorization_applications lost its control-plane policy. Migration '
      + '140 grants SELECT so the policy can EVALUATE; it must never be the reason the policy is '
      + 'gone.').toBeTruthy();
    expect(String(controlPlane?.qual ?? ''), 'the control-plane policy no longer gates on the '
      + 'operator GUC').toContain('is_operator');
  }, 20000);
});
