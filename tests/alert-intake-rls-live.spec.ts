/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The guard the ADR-119 ladder shipped without. Every P1–P4 spec stubs the ticket gateway, so all 32 stayed green while the intake could not write a single row on a live box — "new row violates row-level security policy for table tickets". This one drives the REAL Alertmanager router over a REAL PostgresTicketStore on a REAL RLS-enforcing `tickets` table, connected as the K5 least-privilege NOBYPASSRLS role, and pins BOTH halves of the fix independently (the connection GUC and the row's owner_sub) so removing either goes red.
 */

/**
 * ADR-119 alert intake — live RLS proof.
 *
 * WHY THIS IS NOT A UNIT SPEC: the defect it guards is invisible to a stubbed gateway.
 * The intake code was correct; Postgres refused the row. Only a real INSERT, as a role
 * that RLS actually applies to, against a table with the enforce-stage policy, can tell
 * the two apart. This spec is the shape `scripts/governance/verify-rls-isolation.mjs`
 * established (real connection, synthetic rows, GUCs stamped the way the app stamps them)
 * pointed at the alert path instead of at raw SQL.
 *
 * WHY IT NEVER SKIPS: a guard that skips in CI is a guard that does not exist (CLAUDE.md
 * "Guard-per-fix"). Without DATABASE_URL this FAILS. It runs in the ci-local e2e gate,
 * which stands up Postgres and runs migrations — see tests/e2e-green-suite.txt.
 *
 * SELF-VALIDATION: the three rejection cases below are not decoration. They prove RLS is
 * genuinely enforcing inside this fixture, so the passing case means something. If a future
 * change disables RLS to "make the test pass", the rejection cases go red instead.
 */

import { test, expect } from '@playwright/test';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { Pool } from 'pg';

import { createAlertmanagerRoutes } from '@/app/routes/alertmanager-routes';
import { ALERT_INTAKE_OWNER_SUB } from '@/features/alert-triage';
import { PostgresTicketStore, TicketService } from '@/features/ticketing';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';

const DB_URL = process.env.DATABASE_URL ?? '';

/**
 * The role the intake's connection runs as. `oshal_bot` is the K5 least-privilege role
 * (migration 099: NOSUPERUSER + NOBYPASSRLS + DML only) — the posture the fix has to keep
 * working under. Postgres exempts superusers and BYPASSRLS roles from RLS entirely, so
 * running this proof as the migration superuser would make it pass with the bug present.
 */
const LEAST_PRIVILEGE_ROLE = process.env.OSHAL_RLS_TEST_ROLE || 'oshal_bot';

const WEBHOOK_TOKEN = 'alert-intake-rls-live-spec-token';
const TICKET_TYPE = 'intelligent-processing';

/** Unique per run so reruns never collide on the (external_provider, external_id) claim. */
const RUN = crypto.randomBytes(6).toString('hex');
const ALERTNAME = `RlsLiveProbe${RUN}`;
const TARGET = `oshal-local-rls-probe-${RUN}`;

let adminPool: Pool;
let probePool: Pool;
let gucPool: Pool;
let ticketService: TicketService;
let server: http.Server;
let baseUrl: string;
/** True when THIS spec applied the enforce-stage policy and must therefore remove it. */
let policyWasApplifiedByUs = false;
const savedEnv: Record<string, string | undefined> = {};

/** Environment the router reads at construction; pinned so the run is deterministic. */
const ENV_KEYS = [
  'ALERT_WEBHOOK_TOKEN',
  'ALERT_WEBHOOK_HMAC_SECRET',
  'ALERT_CLAIMS_FILE',
  'ALERT_APPROVED_NAMES',
  'ALERT_BACKLOG_NAMES',
  'ALERT_DEFAULT_INTAKE',
  'ALERT_TICKET_TYPE',
  'ALERT_UNCLAIMED_POLICY',
  'ALERT_RCA_HOURLY_BUDGET_USD',
  'OSHAL_DB_GUC',
  'OSHAL_DB_GUC_STRICT',
];

/** The Alertmanager v4 envelope, exactly the shape Alertmanager POSTs. */
function firingPayload(): Record<string, unknown> {
  return {
    version: '4',
    status: 'firing',
    alerts: [
      {
        status: 'firing',
        labels: { alertname: ALERTNAME, container: TARGET, severity: 'critical', job: 'oshal-swarm-bots' },
        annotations: { summary: `${TARGET} is down`, description: 'live RLS proof' },
        startsAt: new Date().toISOString(),
        fingerprint: `fp-${RUN}`,
        generatorURL: 'http://127.0.0.1:9091/graph',
      },
    ],
  };
}

/** Minimal create input for the mutation cases (same table, same store, same code path). */
function probeTicketInput(ownerSub: string | null): Parameters<TicketService['createTicket']>[0] {
  return {
    title: `rls mutation probe ${crypto.randomBytes(4).toString('hex')}`,
    ticketType: TICKET_TYPE,
    description: 'mutation probe',
    status: 'backlog',
    priority: 'medium',
    labels: ['rls-live-probe'],
    ownerSub,
    workspaceId: null,
    assignedAgentId: null,
    parentTicketId: null,
    externalProvider: 'prometheus',
    externalId: `rls-mutation-${crypto.randomBytes(6).toString('hex')}`,
    externalUrl: null,
    metadata: { source: 'rls-live-probe' },
  };
}

test.beforeAll(async () => {
  // FAIL, never skip: this proof is the entire point of the change that added it.
  expect(
    DB_URL,
    'DATABASE_URL is required — this guard proves a REAL insert against a REAL RLS-enabled '
      + 'tickets table. Run it under the ci-local e2e gate (which stands up Postgres) or point '
      + 'DATABASE_URL at a dev database.',
  ).not.toBe('');

  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.ALERT_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
  delete process.env.ALERT_WEBHOOK_HMAC_SECRET;
  delete process.env.ALERT_CLAIMS_FILE;
  delete process.env.ALERT_APPROVED_NAMES;
  delete process.env.ALERT_BACKLOG_NAMES;
  delete process.env.ALERT_UNCLAIMED_POLICY;
  process.env.ALERT_DEFAULT_INTAKE = 'approved';
  process.env.ALERT_TICKET_TYPE = TICKET_TYPE;
  // A budget gate reading no ledger is an explicit pass-through, but pin the knob anyway so
  // an operator .env with a $0 budget cannot turn a created ticket into a parked one.
  process.env.ALERT_RCA_HOURLY_BUDGET_USD = '100';
  // The two knobs whose defaults ARE the posture under test. Pinned so a break-glass value
  // in the ambient environment cannot make this proof vacuous.
  process.env.OSHAL_DB_GUC = 'on';
  process.env.OSHAL_DB_GUC_STRICT = 'deny';

  adminPool = new Pool({ connectionString: DB_URL });

  // The least-privilege role. Present on any migrated database (migration 099); created here
  // for a database that predates it so the proof is self-sufficient.
  await adminPool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LEAST_PRIVILEGE_ROLE}') THEN
        CREATE ROLE ${LEAST_PRIVILEGE_ROLE} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
      END IF;
    END $$;
  `);
  await adminPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON tickets, ticket_status_history TO ${LEAST_PRIVILEGE_ROLE}`);
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO ${LEAST_PRIVILEGE_ROLE}`);

  // Refuse to run against a role RLS cannot apply to — the failure mode that would make this
  // spec a green rubber stamp. (verify-rls-isolation.mjs refuses for the same reason.)
  const attrs = await adminPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
    [LEAST_PRIVILEGE_ROLE],
  );
  expect(attrs.rows[0]?.rolsuper, `${LEAST_PRIVILEGE_ROLE} must not be SUPERUSER — RLS would not apply`).toBe(false);
  expect(attrs.rows[0]?.rolbypassrls, `${LEAST_PRIVILEGE_ROLE} must not have BYPASSRLS — RLS would not apply`).toBe(false);

  // The enforce-stage policy. A deployed box already has it (applied by
  // scripts/governance/apply-rls.mjs, not by a migration), so leave it alone there; a fresh
  // CI database does not, so apply it and remember to undo exactly what we did.
  const existing = await adminPool.query(
    "SELECT 1 FROM pg_policies WHERE tablename = 'tickets' AND policyname = 'tickets_owner_or_operator'",
  );
  if (existing.rowCount === 0) {
    await adminPool.query('ALTER TABLE tickets ENABLE ROW LEVEL SECURITY');
    await adminPool.query('ALTER TABLE tickets FORCE ROW LEVEL SECURITY');
    await adminPool.query(`
      CREATE POLICY tickets_owner_or_operator ON tickets
        AS PERMISSIVE FOR ALL
        USING (owner_sub = current_setting('oshal.current_sub', true)
               OR current_setting('oshal.is_operator', true) = 'on')
        WITH CHECK (owner_sub = current_setting('oshal.current_sub', true)
               OR current_setting('oshal.is_operator', true) = 'on')
    `);
    policyWasApplifiedByUs = true;
  }

  // The intake's own connection: least-privilege role, GUC-wrapped exactly as
  // composition-root wraps the runtime pool.
  probePool = new Pool({ connectionString: DB_URL, options: `-c role=${LEAST_PRIVILEGE_ROLE}` });
  const roleCheck = await probePool.query<{ current_user: string }>('SELECT current_user');
  expect(roleCheck.rows[0].current_user).toBe(LEAST_PRIVILEGE_ROLE);

  gucPool = wrapPoolWithGuc(probePool);
  ticketService = new TicketService(new PostgresTicketStore(gucPool));

  const app = express();
  app.use(express.json());
  app.use('/api/alerts', createAlertmanagerRoutes(ticketService));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (adminPool) {
    await adminPool.query("DELETE FROM tickets WHERE owner_sub = $1 AND metadata->>'alertname' = $2", [
      ALERT_INTAKE_OWNER_SUB,
      ALERTNAME,
    ]);
    await adminPool.query("DELETE FROM tickets WHERE labels @> ARRAY['rls-live-probe']::text[]");
    if (policyWasApplifiedByUs) {
      await adminPool.query('DROP POLICY IF EXISTS tickets_owner_or_operator ON tickets');
      await adminPool.query('ALTER TABLE tickets NO FORCE ROW LEVEL SECURITY');
      await adminPool.query('ALTER TABLE tickets DISABLE ROW LEVEL SECURITY');
    }
  }
  await probePool?.end();
  await adminPool?.end();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test.describe('ADR-119 alert intake writes a real ticket through real RLS', () => {
  test('an authenticated Alertmanager POST creates a row owned by the machine sub', async () => {
    const response = await fetch(`${baseUrl}/api/alerts/alertmanager`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WEBHOOK_TOKEN}` },
      body: JSON.stringify(firingPayload()),
    });
    const body = (await response.json()) as { success: boolean; created: number; ticketIds: string[] };

    expect(response.status).toBe(200);
    // The pre-fix behaviour was HTTP 200 with created:0 — the handler catches the RLS
    // rejection and logs it. Asserting only on the status code would have passed then too.
    expect(body.created, 'the intake must actually create a ticket, not swallow an RLS refusal').toBe(1);
    expect(body.ticketIds).toHaveLength(1);

    // Read the row back on the ADMIN connection: what the database really holds, not what
    // the caller's own RLS-scoped view is willing to show it.
    const row = await adminPool.query<{ owner_sub: string | null; status: string; external_id: string }>(
      'SELECT owner_sub, status, external_id FROM tickets WHERE ticket_id = $1',
      [body.ticketIds[0]],
    );
    expect(row.rowCount, 'the ticket must exist in Postgres').toBe(1);
    expect(row.rows[0].owner_sub).toBe(ALERT_INTAKE_OWNER_SUB);
    expect(row.rows[0].external_id).toContain(`${ALERTNAME}::${TARGET}`);
  });

  test('MUTATION — anonymous identity + machine owner_sub is refused (the GUC half is load-bearing)', async () => {
    // Removing the route's runWithRequestIdentity re-entry reproduces exactly this: the row
    // carries the right owner but the connection is stamped anonymous.
    await expect(
      runWithRequestIdentity({ sub: null, isOperator: false }, () =>
        ticketService.createTicket(probeTicketInput(ALERT_INTAKE_OWNER_SUB))),
    ).rejects.toThrow(/row-level security/i);
  });

  test('MUTATION — machine identity + null owner_sub is refused (the ownerSub half is load-bearing)', async () => {
    // Removing `ownerSub: ALERT_INTAKE_OWNER_SUB` from createIncidentTicket reproduces this:
    // the connection is stamped, but NULL never equals the stamped sub.
    await expect(
      runWithRequestIdentity({ sub: ALERT_INTAKE_OWNER_SUB, isOperator: false }, () =>
        ticketService.createTicket(probeTicketInput(null))),
    ).rejects.toThrow(/row-level security/i);
  });

  test('CONTROL — the exact pre-fix combination (anonymous + no owner) is refused', async () => {
    // This is the production failure reproduced verbatim. If it ever passes, RLS is not
    // enforcing in this fixture and every assertion above is meaningless.
    await expect(
      runWithRequestIdentity({ sub: null, isOperator: false }, () =>
        ticketService.createTicket(probeTicketInput(null))),
    ).rejects.toThrow(/row-level security/i);
  });
});
