/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The live half of the machine-write identity fix for the ADR-065 connector webhook ingress. The unit gate (tests/unit/machine-write-identity.spec.ts) proves the ingress STAMPS the synthetic sub; only a real INSERT as a NOBYPASSRLS role against a real enforce-stage policy proves Postgres AGREES. Modelled directly on tests/alert-intake-rls-live.spec.ts, because the reason that spec exists — every stubbed guard stayed green while the write was impossible — applies verbatim here.
 */

/**
 * ADR-065 connector webhook ingress — live RLS proof.
 *
 * WHY THIS IS NOT A UNIT SPEC: the previous posture ran the whole dispatch under
 * `runWithSystemIdentity` (operator), so nothing was ever refused — every webhook-born ticket
 * simply landed with `owner_sub = NULL`. A stubbed ticket gateway cannot tell an owned row from an
 * owner-less one, which is exactly why six green unit specs never noticed. This drives the REAL
 * ingress router over a REAL PostgresTicketStore, connected as the K5 least-privilege
 * NOBYPASSRLS role, against a REAL RLS-enforcing `tickets` table, and reads the row back on an
 * ADMIN connection to see what Postgres actually stored.
 *
 * WHY IT NEVER SKIPS: a guard that skips in CI is a guard that does not exist (CLAUDE.md
 * "Guard-per-fix"). Without DATABASE_URL this FAILS. It runs in the ci-local e2e gate, which
 * stands up Postgres and runs migrations — see tests/e2e-green-suite.txt.
 *
 * SELF-VALIDATION: the three rejection cases are not decoration. They prove RLS is genuinely
 * enforcing inside this fixture, so the passing case means something. If a future change disables
 * RLS to "make the test pass", the rejection cases go red instead.
 */

import { test, expect } from '@playwright/test';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { Pool } from 'pg';

import {
  createConnectorWebhookHandler,
  webhookOwnerSub,
} from '@/app/routes/connector-webhook-routes';
import {
  createWebhookIngressRouter,
  inMemorySeenStore,
  type WebhookEventSpec,
} from '@/app/connectors/webhooks/webhook-ingress';
import { PostgresTicketStore, TicketService } from '@/features/ticketing';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';

const DB_URL = process.env.DATABASE_URL ?? '';

/**
 * The role the ingress's connection runs as. `oshal_bot` is the K5 least-privilege role
 * (migration 099: NOSUPERUSER + NOBYPASSRLS + DML only) — the posture the fix has to keep working
 * under. Postgres exempts superusers and BYPASSRLS roles from RLS entirely, so running this proof
 * as the migration superuser would make it pass with the bug present.
 */
const LEAST_PRIVILEGE_ROLE = process.env.OSHAL_RLS_TEST_ROLE || 'oshal_bot';

/** Unique per run so reruns never collide on the (external_provider, external_id) claim. */
const RUN = crypto.randomBytes(6).toString('hex');
/** A synthetic provider: this proof is about identity, not about any real connector's catalog entry. */
const PROVIDER = `rlsprobe${RUN}`;
const EVENT = 'probe.fired';
const HMAC_SECRET = `webhook-rls-live-secret-${RUN}`;
const EXPECTED_OWNER = webhookOwnerSub(PROVIDER);

let adminPool: Pool;
let probePool: Pool;
let ticketService: TicketService;
let server: http.Server;
let baseUrl: string;
/** True when THIS spec applied the enforce-stage policy and must therefore remove it. */
let policyAppliedByUs = false;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['OSHAL_DB_GUC', 'OSHAL_DB_GUC_STRICT', 'GITHUB_TICKET_FEEDS'];

/** Minimal create input for the mutation cases (same table, same store, same code path). */
function probeTicketInput(ownerSub: string | null): Parameters<TicketService['createTicket']>[0] {
  return {
    title: `webhook rls mutation probe ${crypto.randomBytes(4).toString('hex')}`,
    ticketType: 'intelligent-processing',
    description: 'mutation probe',
    status: 'backlog',
    priority: 'medium',
    labels: ['webhook-rls-live-probe'],
    ownerSub,
    workspaceId: null,
    assignedAgentId: null,
    parentTicketId: null,
    externalProvider: PROVIDER,
    externalId: `webhook-rls-mutation-${crypto.randomBytes(6).toString('hex')}`,
    externalUrl: null,
    metadata: { source: 'webhook-rls-live-probe' },
  };
}

/** The delivery Alertmanager's connector-webhook sibling would send: a body plus its HMAC. */
function signedDelivery(body: string): { signature: string; deliveryId: string } {
  return {
    signature: `sha256=${crypto.createHmac('sha256', HMAC_SECRET).update(body, 'utf8').digest('hex')}`,
    deliveryId: `dlv-${RUN}`,
  };
}

test.beforeAll(async () => {
  // FAIL, never skip: this proof is the entire point of the change that added it.
  expect(
    DB_URL,
    'DATABASE_URL is required — this guard proves a REAL insert against a REAL RLS-enabled tickets '
      + 'table. Run it under the ci-local e2e gate (which stands up Postgres) or point DATABASE_URL '
      + 'at a dev database.',
  ).not.toBe('');

  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // The knobs whose defaults ARE the posture under test. Pinned so a break-glass value in the
  // ambient environment cannot make this proof vacuous.
  process.env.OSHAL_DB_GUC = 'on';
  process.env.OSHAL_DB_GUC_STRICT = 'deny';
  // No GitHub feed configured: this proof drives the GENERIC connector path, so the specialized
  // issue synchronizer must not intercept it.
  delete process.env.GITHUB_TICKET_FEEDS;

  adminPool = new Pool({ connectionString: DB_URL });

  // The least-privilege role. Present on any migrated database (migration 099); created here for a
  // database that predates it so the proof is self-sufficient.
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

  // Refuse to run against a role RLS cannot apply to — the failure mode that would make this spec
  // a green rubber stamp.
  const attrs = await adminPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
    [LEAST_PRIVILEGE_ROLE],
  );
  expect(attrs.rows[0]?.rolsuper, `${LEAST_PRIVILEGE_ROLE} must not be SUPERUSER — RLS would not apply`).toBe(false);
  expect(attrs.rows[0]?.rolbypassrls, `${LEAST_PRIVILEGE_ROLE} must not have BYPASSRLS — RLS would not apply`).toBe(false);

  // The enforce-stage policy. A deployed box already has it (applied by
  // scripts/governance/apply-rls.mjs, not by a migration); a fresh CI database does not.
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
    policyAppliedByUs = true;
  }

  // The ingress's own connection: least-privilege role, GUC-wrapped exactly as composition-root
  // wraps the runtime pool.
  probePool = new Pool({ connectionString: DB_URL, options: `-c role=${LEAST_PRIVILEGE_ROLE}` });
  const roleCheck = await probePool.query<{ current_user: string }>('SELECT current_user');
  expect(roleCheck.rows[0].current_user).toBe(LEAST_PRIVILEGE_ROLE);

  ticketService = new TicketService(new PostgresTicketStore(wrapPoolWithGuc(probePool)));

  // The REAL ingress: signature verification, dedup, then the real dispatcher. Mounted the way
  // mountConnectorWebhookRoutes mounts it, with the catalog replaced by one synthetic event so the
  // proof does not depend on a live connector's secret being configured.
  const events: WebhookEventSpec[] = [{
    provider: PROVIDER,
    event: EVENT,
    verify: { type: 'hmac', header: 'X-Probe-Signature', secret: HMAC_SECRET },
  }];
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as { rawBody?: string }).rawBody = buf.toString('utf8'); } }));
  app.use('/api/hooks', createWebhookIngressRouter({
    events,
    onEvent: createConnectorWebhookHandler(ticketService as never),
    seen: inMemorySeenStore(),
    deliveryIdHeader: 'x-probe-delivery',
  }));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (adminPool) {
    await adminPool.query('DELETE FROM tickets WHERE external_provider = $1', [PROVIDER]);
    await adminPool.query("DELETE FROM tickets WHERE labels @> ARRAY['webhook-rls-live-probe']::text[]");
    if (policyAppliedByUs) {
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

test.describe('ADR-065 connector webhook ingress writes a real ticket through real RLS', () => {
  test('a correctly signed delivery creates a row owned by the synthetic webhook sub', async () => {
    const body = JSON.stringify({ id: `evt-${RUN}`, kind: 'probe' });
    const { signature, deliveryId } = signedDelivery(body);

    const response = await fetch(`${baseUrl}/api/hooks/${PROVIDER}/${EVENT}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-probe-signature': signature,
        'x-probe-delivery': deliveryId,
      },
      body,
    });
    // The pre-fix behaviour was HTTP 200 with a row whose owner was NULL, so asserting only on the
    // status code would have passed then too. The row itself is the assertion.
    expect(response.status).toBe(200);
    expect((await response.json()) as { ok: boolean }).toMatchObject({ ok: true });

    // Read back on the ADMIN connection: what the database really holds, not what the caller's own
    // RLS-scoped view is willing to show it.
    const row = await adminPool.query<{ owner_sub: string | null; external_id: string; status: string }>(
      'SELECT owner_sub, external_id, status FROM tickets WHERE external_provider = $1 AND external_id = $2',
      [PROVIDER, deliveryId],
    );
    expect(row.rowCount, 'the ingress must actually create a ticket, not swallow an RLS refusal').toBe(1);
    expect(
      row.rows[0].owner_sub,
      'an owner-less webhook ticket is the defect: invisible to every per-owner rail',
    ).toBe(EXPECTED_OWNER);
  });

  test('a wrongly signed delivery writes nothing (the identity is established only after verification)', async () => {
    const body = JSON.stringify({ id: `evt-bad-${RUN}` });
    const before = await adminPool.query('SELECT count(*)::int AS n FROM tickets WHERE external_provider = $1', [PROVIDER]);

    const response = await fetch(`${baseUrl}/api/hooks/${PROVIDER}/${EVENT}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-probe-signature': 'sha256=deadbeef',
        'x-probe-delivery': `dlv-bad-${RUN}`,
      },
      body,
    });
    expect(response.status).toBe(401);

    const after = await adminPool.query('SELECT count(*)::int AS n FROM tickets WHERE external_provider = $1', [PROVIDER]);
    expect(after.rows[0].n, 'an unsigned caller must never reach the machine identity').toBe(before.rows[0].n);
  });

  test('MUTATION — anonymous identity + machine owner_sub is refused (the GUC half is load-bearing)', async () => {
    // Removing the handler's runWithRequestIdentity re-entry reproduces exactly this: the row
    // carries the right owner but the connection is stamped anonymous.
    await expect(
      runWithRequestIdentity({ sub: null, isOperator: false }, () =>
        ticketService.createTicket(probeTicketInput(EXPECTED_OWNER))),
    ).rejects.toThrow(/row-level security/i);
  });

  test('MUTATION — machine identity + null owner_sub is refused (the ownerSub half is load-bearing)', async () => {
    // Removing `ownerSub` from makeTicketSink / buildCreateInput reproduces this: the connection is
    // stamped, but NULL never equals the stamped sub.
    await expect(
      runWithRequestIdentity({ sub: EXPECTED_OWNER, isOperator: false }, () =>
        ticketService.createTicket(probeTicketInput(null))),
    ).rejects.toThrow(/row-level security/i);
  });

  test('MUTATION — one provider cannot own another provider’s webhook ticket', async () => {
    // Why the owner is per-provider rather than one flat `webhook:*`: a party holding provider A's
    // signing secret must not be able to write (or later read) provider B's rows.
    await expect(
      runWithRequestIdentity({ sub: webhookOwnerSub('some-other-provider'), isOperator: false }, () =>
        ticketService.createTicket(probeTicketInput(EXPECTED_OWNER))),
    ).rejects.toThrow(/row-level security/i);
  });
});
