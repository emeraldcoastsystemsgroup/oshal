/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-124 RLS Phase 2 guard: a REAL two-identity isolation proof against the tables migrations 112/113 walled, executed as the NOBYPASSRLS oshal_bot role. Covers both new policy shapes — the direct owner column (voice_user_prefs.user_sub, migration 112) and the derived owner through a parent FK (ticket_status_history -> tickets.owner_sub via oshal_owns_ticket, migration 113) — with read, update, delete and cross-owner insert all asserted for the second identity. Fails rather than skips when DATABASE_URL is absent, and refuses to run against a role RLS cannot apply to.
 */

/**
 * ADR-124 — live two-role RLS isolation proof (RLS Phase 2).
 *
 * WHY THIS IS NOT A UNIT SPEC: the property under test is "Postgres refuses",
 * and nothing short of Postgres can assert it. Migrations 112/113 wall fourteen
 * tables; a stubbed store would happily "prove" isolation that the database is
 * not enforcing. This drives real INSERT/SELECT/UPDATE/DELETE over a real pool,
 * connected as the K5 least-privilege `oshal_bot` role (migration 099:
 * NOSUPERUSER + NOBYPASSRLS), which is the posture bot nodes actually run in.
 *
 * WHY IT NEVER SKIPS: a guard that skips in CI is a guard that does not exist
 * (CLAUDE.md "Guard-per-fix"). Without a database URL this FAILS.
 *
 * SUPERUSER MASKS RLS. Two defences against a vacuous green:
 *   1. The probe role's pg_roles attributes are asserted NOSUPERUSER/NOBYPASSRLS
 *      before a single row is written.
 *   2. The admin/verification connection never relies on being a superuser — it
 *      stamps `oshal.is_operator='on'`, the operator arm every policy in this
 *      codebase carries — so the readback works under `oshal_app` too, and a
 *      readback that returns nothing is a real failure rather than an artefact
 *      of the DSN the operator happened to export.
 *
 * SELF-VALIDATION: the isolation cases are two-sided. Every "identity B cannot
 * see it" is paired with an "identity A can" on the same row, so a policy that
 * denies EVERYONE (the other way to make an isolation test pass) goes red too.
 */

import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { Pool } from 'pg';

import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';

/**
 * Admin/verification DSN. Prefers an explicitly privileged URL when the operator
 * exports one; otherwise DATABASE_URL, which on this platform is the table-owning
 * `oshal_app` role. Either way every admin query runs operator-stamped (see
 * {@link adminQuery}), so the readback sees what the database really holds.
 */
const ADMIN_URL =
  process.env.OSHAL_RLS_ADMIN_DATABASE_URL
  ?? process.env.BOOTSTRAP_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? '';

/** The role the proof runs as — bot nodes' real role (migration 099). */
const PROBE_ROLE = process.env.OSHAL_RLS_TEST_ROLE || 'oshal_bot';

/**
 * How the probe connection BECOMES that role. Two shapes, because the two
 * environments differ and neither may be assumed:
 *   * a real credentialed DSN for the role (BOT_DATABASE_URL — what bot containers
 *     actually use, and the only option when the admin DSN is `oshal_app`, which is
 *     NOT a member of oshal_bot and gets "permission denied to set role");
 *   * otherwise `-c role=` over the admin DSN, which works when that DSN is the
 *     migration superuser (the CI shape).
 * Either way the connection asserts `current_user` afterwards, so a silent
 * fallback to the admin role can never make this proof vacuous.
 */
const PROBE_URL = process.env.OSHAL_RLS_PROBE_DATABASE_URL ?? process.env.BOT_DATABASE_URL ?? '';

/** Unique per run so reruns never collide and cleanup can be exact. */
const RUN = crypto.randomBytes(6).toString('hex');
const SUB_A = `rls-phase2-a-${RUN}`;
const SUB_B = `rls-phase2-b-${RUN}`;

let adminPool: Pool;
let probePool: Pool;
let gucPool: Pool;
let ticketId: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['OSHAL_DB_GUC', 'OSHAL_DB_GUC_STRICT'];

/**
 * @description Runs a query on a dedicated admin connection stamped as trusted
 * operator, so FORCE ROW LEVEL SECURITY (which applies to the table OWNER too)
 * cannot silently filter the verification read. This is the only honest way to
 * ask "what does the row actually look like" without demanding a superuser DSN.
 * @param sql - Statement to run.
 * @param params - Bound parameters.
 * @returns The pg result rows.
 */
async function adminQuery<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await adminPool.connect();
  try {
    await client.query("SELECT set_config('oshal.is_operator', 'on', false)");
    const result = await client.query<T>(sql, params);
    return result.rows;
  } finally {
    await client.query('RESET oshal.is_operator').catch(() => undefined);
    client.release();
  }
}

/** Runs `fn` with the connection stamped as a plain (non-operator) end user. */
function asUser<T>(sub: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestIdentity({ sub, isOperator: false }, fn);
}

test.beforeAll(async () => {
  // FAIL, never skip.
  expect(
    ADMIN_URL,
    'DATABASE_URL (or OSHAL_RLS_ADMIN_DATABASE_URL) is required — this guard proves REAL row '
      + 'isolation against REAL RLS-enabled tables. Run it under the ci-local e2e gate, which '
      + 'stands up Postgres and applies migrations.',
  ).not.toBe('');

  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // The knobs whose values ARE the posture under test — pinned so a break-glass
  // value in the ambient environment cannot make this proof vacuous.
  process.env.OSHAL_DB_GUC = 'on';
  process.env.OSHAL_DB_GUC_STRICT = 'deny';

  adminPool = new Pool({ connectionString: ADMIN_URL });

  // The probe role must EXIST and must be one RLS applies to. This spec never
  // creates or alters it: oshal_bot's least-privilege shape is migration 099's
  // contract and is not this guard's to widen.
  const attrs = await adminQuery<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
    [PROBE_ROLE],
  );
  expect(
    attrs.length,
    `${PROBE_ROLE} does not exist — apply scripts/migrations/099-bot-db-role.sql over a superuser DSN first`,
  ).toBe(1);
  expect(attrs[0].rolsuper, `${PROBE_ROLE} must not be SUPERUSER — RLS would not apply and this proof would be vacuous`).toBe(false);
  expect(attrs[0].rolbypassrls, `${PROBE_ROLE} must not have BYPASSRLS — RLS would not apply and this proof would be vacuous`).toBe(false);

  probePool = PROBE_URL
    ? new Pool({ connectionString: PROBE_URL })
    : new Pool({ connectionString: ADMIN_URL, options: `-c role=${PROBE_ROLE}` });
  const who = await probePool.query<{ current_user: string }>('SELECT current_user');
  expect(
    who.rows[0].current_user,
    `the probe connection is ${who.rows[0].current_user}, not ${PROBE_ROLE} — set BOT_DATABASE_URL `
      + '(or OSHAL_RLS_PROBE_DATABASE_URL) to the role’s own DSN. Proving isolation as the admin '
      + 'role would prove nothing.',
  ).toBe(PROBE_ROLE);

  gucPool = wrapPoolWithGuc(probePool);

  // The parent row the derived-owner half needs. Created operator-side because
  // creating it is not what is under test; owning it is.
  const ticket = await adminQuery<{ ticket_id: string }>(
    // ticket_id has no column default (the app generates it), so supply one here.
    `INSERT INTO tickets (ticket_id, title, description, status, state_group, priority, labels, metadata, ticket_type, owner_sub)
     VALUES (gen_random_uuid(), $1, 'rls phase 2 derived-owner probe', 'backlog', 'backlog', 'low', ARRAY['rls-phase2-probe']::text[], '{}'::jsonb, 'build', $2)
     RETURNING ticket_id`,
    [`rls phase2 probe ${RUN}`, SUB_A],
  );
  ticketId = ticket[0].ticket_id;
});

test.afterAll(async () => {
  if (adminPool) {
    await adminQuery('DELETE FROM voice_user_prefs WHERE user_sub = ANY($1::text[])', [[SUB_A, SUB_B]]).catch(() => undefined);
    await adminQuery('DELETE FROM oshal_cost_events WHERE task_id LIKE $1', [`rls-phase2-%${RUN}`]).catch(() => undefined);
    await adminQuery('DELETE FROM oshal_cost_events WHERE task_id = $1', [`rls-phase2-${RUN}`]).catch(() => undefined);
    if (ticketId) {
      await adminQuery('DELETE FROM ticket_status_history WHERE ticket_id = $1', [ticketId]).catch(() => undefined);
      await adminQuery('DELETE FROM tickets WHERE ticket_id = $1', [ticketId]).catch(() => undefined);
    }
  }
  await probePool?.end();
  await adminPool?.end();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test.describe('migration 112 — direct owner column (voice_user_prefs.user_sub)', () => {
  test('identity A can insert its own row', async () => {
    await asUser(SUB_A, () =>
      gucPool.query(
        `INSERT INTO voice_user_prefs (user_sub, tts_provider, tts_voice, updated_at)
         VALUES ($1, 'rls-probe', $2, NOW())
         ON CONFLICT (user_sub) DO UPDATE SET tts_voice = EXCLUDED.tts_voice`,
        [SUB_A, `voice-${RUN}`],
      ));

    // Operator-side readback: the row is genuinely in the table, so the
    // "B sees nothing" assertions below mean isolation and not an empty table.
    const rows = await adminQuery<{ tts_voice: string }>('SELECT tts_voice FROM voice_user_prefs WHERE user_sub = $1', [SUB_A]);
    expect(rows).toHaveLength(1);
    expect(rows[0].tts_voice).toBe(`voice-${RUN}`);
  });

  test('identity A can read its own row back', async () => {
    const res = await asUser(SUB_A, () =>
      gucPool.query('SELECT user_sub FROM voice_user_prefs WHERE user_sub = $1', [SUB_A]));
    expect((res as { rowCount: number }).rowCount, 'the owner must still see its own row — a deny-everyone policy is not isolation').toBe(1);
  });

  test('identity B cannot SELECT it', async () => {
    const res = await asUser(SUB_B, () =>
      gucPool.query('SELECT user_sub, tts_voice FROM voice_user_prefs WHERE user_sub = $1', [SUB_A]));
    expect((res as { rowCount: number }).rowCount).toBe(0);
  });

  test('identity B cannot UPDATE it', async () => {
    const res = await asUser(SUB_B, () =>
      gucPool.query("UPDATE voice_user_prefs SET tts_voice = 'hijacked' WHERE user_sub = $1", [SUB_A]));
    expect((res as { rowCount: number }).rowCount, 'UPDATE must affect zero rows — RLS hides the row from the UPDATE scan').toBe(0);

    const after = await adminQuery<{ tts_voice: string }>('SELECT tts_voice FROM voice_user_prefs WHERE user_sub = $1', [SUB_A]);
    expect(after[0].tts_voice, "A's row must be untouched").toBe(`voice-${RUN}`);
  });

  test('identity B cannot DELETE it', async () => {
    const res = await asUser(SUB_B, () =>
      gucPool.query('DELETE FROM voice_user_prefs WHERE user_sub = $1', [SUB_A]));
    expect((res as { rowCount: number }).rowCount).toBe(0);

    const after = await adminQuery('SELECT 1 FROM voice_user_prefs WHERE user_sub = $1', [SUB_A]);
    expect(after, "A's row must survive B's delete").toHaveLength(1);
  });

  test('identity B cannot INSERT a row owned by A (WITH CHECK half)', async () => {
    await expect(
      asUser(SUB_B, () =>
        gucPool.query(
          "INSERT INTO voice_user_prefs (user_sub, tts_provider, tts_voice, updated_at) VALUES ($1, 'rls-probe', 'forged', NOW())",
          [SUB_A],
        )),
    ).rejects.toThrow(/row-level security/i);
  });
});

test.describe('migration 113 — derived owner through tickets.owner_sub', () => {
  test('identity A can insert history against its own ticket', async () => {
    await asUser(SUB_A, () =>
      gucPool.query(
        `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, changed_by_label, metadata)
         VALUES ($1, 'backlog', 'in_progress', $2, 'rls phase 2 probe', '{}'::jsonb)`,
        [ticketId, SUB_A],
      ));

    const rows = await adminQuery('SELECT 1 FROM ticket_status_history WHERE ticket_id = $1', [ticketId]);
    expect(rows).toHaveLength(1);
  });

  test('identity A can read the history of its own ticket', async () => {
    const res = await asUser(SUB_A, () =>
      gucPool.query('SELECT to_status FROM ticket_status_history WHERE ticket_id = $1', [ticketId]));
    expect((res as { rowCount: number }).rowCount, 'the ticket owner must still see its own history').toBe(1);
  });

  test('identity B cannot SELECT the history of A\'s ticket', async () => {
    const res = await asUser(SUB_B, () =>
      gucPool.query('SELECT to_status, changed_by FROM ticket_status_history WHERE ticket_id = $1', [ticketId]));
    expect((res as { rowCount: number }).rowCount, 'ownership must be derived through the parent ticket, not left open').toBe(0);
  });

  test('identity B cannot DELETE the history of A\'s ticket', async () => {
    const res = await asUser(SUB_B, () =>
      gucPool.query('DELETE FROM ticket_status_history WHERE ticket_id = $1', [ticketId]));
    expect((res as { rowCount: number }).rowCount).toBe(0);

    const after = await adminQuery('SELECT 1 FROM ticket_status_history WHERE ticket_id = $1', [ticketId]);
    expect(after, "A's history must survive B's delete").toHaveLength(1);
  });

  test('identity B cannot INSERT history against A\'s ticket (derived WITH CHECK half)', async () => {
    await expect(
      asUser(SUB_B, () =>
        gucPool.query(
          `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, changed_by_label, metadata)
           VALUES ($1, 'in_progress', 'done', $2, 'forged', '{}'::jsonb)`,
          [ticketId, SUB_B],
        )),
    ).rejects.toThrow(/row-level security/i);
  });

  test('CONTROL — an anonymous identity sees neither table (the fail-closed arm)', async () => {
    // Anonymous connections are stamped sub='' / is_operator='off'. No row has an
    // owner of '', so both the direct and the derived policy must starve them. If
    // this ever passes, the GUC plumbing is not stamping and every case above is
    // meaningless.
    const prefs = await asUser('', () =>
      gucPool.query('SELECT 1 FROM voice_user_prefs WHERE user_sub = $1', [SUB_A]));
    const history = await asUser('', () =>
      gucPool.query('SELECT 1 FROM ticket_status_history WHERE ticket_id = $1', [ticketId]));
    expect((prefs as { rowCount: number }).rowCount).toBe(0);
    expect((history as { rowCount: number }).rowCount).toBe(0);
  });
});

test.describe('migration 112 — the cost ledger refuses a mis-owned row', () => {
  // This is the case that makes cost-tracking-service's isRlsRefusal branch reachable.
  // Before ADR-124 the writer logged EVERY ledger failure at warn and continued, so a
  // refusal here was invisible spend and the windowed budget caps failed OPEN.
  test('identity A can append its own cost row', async () => {
    await asUser(SUB_A, () =>
      gucPool.query(
        `INSERT INTO oshal_cost_events (task_id, owner_sub, agent_id, provider_id, model_id, cost_usd)
         VALUES ($1, $2, 'rls-probe-agent', 'noop', 'noop-model', 0.0001)`,
        [`rls-phase2-${RUN}`, SUB_A],
      ));
    const rows = await adminQuery('SELECT 1 FROM oshal_cost_events WHERE task_id = $1', [`rls-phase2-${RUN}`]);
    expect(rows).toHaveLength(1);
  });

  test('identity B cannot see A\'s spend', async () => {
    const res = await asUser(SUB_B, () =>
      gucPool.query('SELECT cost_usd FROM oshal_cost_events WHERE task_id = $1', [`rls-phase2-${RUN}`]));
    expect((res as { rowCount: number }).rowCount, 'per-user spend must not be readable across identities').toBe(0);
  });

  test('identity B cannot append a cost row owned by A', async () => {
    await expect(
      asUser(SUB_B, () =>
        gucPool.query(
          `INSERT INTO oshal_cost_events (task_id, owner_sub, agent_id, provider_id, model_id, cost_usd)
           VALUES ($1, $2, 'rls-probe-agent', 'noop', 'noop-model', 99.99)`,
          [`rls-phase2-forged-${RUN}`, SUB_A],
        )),
    ).rejects.toThrow(/row-level security/i);
  });
});
