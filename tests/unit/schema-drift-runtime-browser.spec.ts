/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Disposable catalog policy drop through the automatic detector, real pending sweep and PostgreSQL ticket service into the same explorer diff in Chromium. Clock, cadence, session identity, empty package inventory and fixed migration count are fixture ports; no deployment database or provider is used.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { PostgresTicketStore, TicketService } from '@/features/ticketing';
import { EnvelopeStore, ensureAlertPipelineSchema } from '@/features/alert-pipeline';
import { createDataModelService, readCatalog, type DataModelService } from '@/features/data-model';
import { createDataModelRoutes } from '@/app/routes/data-model-routes';
import { createAlertmanagerRoutes } from '@/app/routes/alertmanager-routes';
import { createOpsPipelineRoutes } from '@/app/routes/ops-pipeline-routes';
import { createSchemaDriftMonitor, type SchemaDriftMonitor } from '@/app/schema-drift-runtime';
import { requiresOperator } from '@/shared/middleware/authz';
import { runShutdownHooks } from '@/shared/services/shutdown-hooks';
import { ensureTicketSchema } from '@/shared/services/database';

const fixture = new DisposablePostgres({ purpose: 'schema-drift-runtime', max: 12, migrations: [
  '001-multi-agent-foundation.sql', '005-conversation-history-and-usage.sql', '100-ticket-family-base-schema.sql',
  '104-alert-pipeline-core.sql', '105-alert-incident.sql', '106-alert-evidence.sql', '107-alert-config-topology.sql',
  '108-alert-metering.sql', '139-schema-digest-history.sql', '141-alert-event-effects.sql',
  '164-internal-alert-receipts.sql', '165-schema-drift-claim.sql',
], roles: [
  { name: 'pipeline', max: 8, options: '-c oshal.current_sub=alert:prometheus -c oshal.is_operator=off' },
  { name: 'operator', max: 4, options: '-c oshal.current_sub=fixture-operator -c oshal.is_operator=on' },
  { name: 'stranger', options: '-c oshal.current_sub=unrelated -c oshal.is_operator=off' },
] });
let root: string, base: string, server: Server, browser: Browser, service: DataModelService;
let monitor: SchemaDriftMonitor;
let now = Date.now();
const cookieAuth: RequestHandler = (req, res, next) => {
  const sub = /(?:^|;\s*)test-user=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!sub) { res.status(401).json({ error: 'Authentication required' }); return; }
  Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub } } });
  next();
};

async function startHttp(): Promise<void> {
  const app = express();
  app.get('/favicon.ico', (_req, res) => { res.status(204).end(); });
  app.use('/shared/ui', express.static(resolve('src/shared/ui')));
  app.use('/shared', express.static(resolve('src/pages/shared')));
  app.use('/data-model', express.static(resolve('src/pages/data-model')));
  const status = { status: () => monitor.status() } as SchemaDriftMonitor;
  app.use('/api/admin/data-model', cookieAuth, requiresOperator, createDataModelRoutes(service, status));
  app.use('/api/ops/alert-pipeline', express.json(), createOpsPipelineRoutes({ pool: fixture.rolePool('operator'), requiresAuth: cookieAuth }));
  app.use('/api/alerts', createAlertmanagerRoutes(new TicketService(new PostgresTicketStore(fixture.rolePool('pipeline'))), {
    pool: fixture.rolePool('pipeline'),
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'fixture-operator');
  vi.stubEnv('ALERT_APPROVED_NAMES', 'SomeUnrelatedWebhook');
  vi.stubEnv('ALERT_DEFAULT_INTAKE', 'approved');
  await fixture.start();
  await ensureTicketSchema(fixture.pool);
  await ensureAlertPipelineSchema(fixture.pool);
  root = mkdtempSync(join(tmpdir(), 'schema-drift-runtime-'));
  await fixture.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pipeline, operator, stranger;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pipeline, operator, stranger;
    CREATE TABLE schema_alarm_scratch (id uuid PRIMARY KEY, owner_sub text);
    ALTER TABLE schema_alarm_scratch ENABLE ROW LEVEL SECURITY;
    ALTER TABLE schema_alarm_scratch FORCE ROW LEVEL SECURITY;`);
  service = createDataModelService({ repoRoot: root, listApps: async () => [],
    readPlatformCatalog: () => readCatalog(fixture.pool, 'scratch'),
    digestQueryable: async () => fixture.rolePool('operator'), migrationCount: async () => 165,
  }, { ttlMs: 0, now: () => now });
  await startHttp();
  browser = await chromium.launch({ headless: true });
}, 120_000);

beforeEach(async () => {
  monitor?.stop();
  await fixture.pool.query(`TRUNCATE oshal_alert_event, oshal_alert_producer_receipt, oshal_incident,
    oshal_alert_envelope, tickets, oshal_schema_digest CASCADE;
    UPDATE oshal_alert_claim_rule SET enabled = true, intake = 'backlog', autonomy_level = 'A0' WHERE rule_id = 'schema-drift';
    DROP POLICY IF EXISTS scratch_owner ON schema_alarm_scratch;
    CREATE POLICY scratch_owner ON schema_alarm_scratch USING (owner_sub = 'private-expression');`);
  now = Date.now() + 16 * 60_000;
  await service.drift({ refresh: true, capture: true });
  monitor = createSchemaDriftMonitor(fixture.rolePool('pipeline'), service, { now: () => now, start: false });
});

afterAll(async () => {
  monitor?.stop();
  await runShutdownHooks();
  await browser?.close();
  if (server) await new Promise<void>((done) => server.close(() => done()));
  await fixture.stop();
  if (root) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
}, 180_000);

async function operatorPage(): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'test-user', value: 'fixture-operator', url: base }]);
  const page = await context.newPage();
  await page.goto(`${base}/data-model/`);
  await page.waitForFunction(() => document.querySelector('#schemaDrift')?.getAttribute('data-state'));
  return page;
}

async function ticketRows() { return (await fixture.pool.query('SELECT * FROM tickets')).rows; }
async function dropPolicy() { await fixture.pool.query('DROP POLICY scratch_owner ON schema_alarm_scratch'); }
async function awaitTicket() {
  await expect.poll(async () => (await ticketRows()).length, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => Number((await fixture.pool.query("SELECT count(*) FROM oshal_alert_event WHERE claim_decision = 'pending'")).rows[0].count), { timeout: 15_000 }).toBe(0);
}

async function assertOperationsStream(ticketId: string): Promise<void> {
  const headers = { cookie: 'test-user=fixture-operator' };
  const funnelResponse = await fetch(`${base}/api/ops/alert-pipeline/funnel`, { headers });
  expect(funnelResponse.status).toBe(200);
  const funnel = await funnelResponse.json();
  expect(funnel.points).toContainEqual(expect.objectContaining({ source: 'schema-drift', stage: 'tickets_created', count: 1 }));
  const incidentId = (await fixture.pool.query('SELECT incident_id FROM oshal_incident WHERE ticket_id = $1', [ticketId])).rows[0].incident_id;
  const detailResponse = await fetch(`${base}/api/ops/alert-pipeline/incidents/${incidentId}`, { headers });
  expect(detailResponse.status).toBe(200);
  const detail = await detailResponse.json();
  expect(detail.incident.ticketId).toBe(ticketId);
  expect(detail.events[0]).toMatchObject({ source: 'schema-drift', claimedByRule: 'schema-drift',
    annotations: { description: 'scratch.schema_alarm_scratch: policies-changed; before: scratch_owner; after: none' } });
}

describe('schema alarm end-to-end acceptance on isolated data', () => {
  it('automatically produces one native, approval-held ticket and the same browser diff after a real policy drop', async () => {
    await monitor.tick();
    expect(await ticketRows()).toHaveLength(0);
    monitor.stop();
    monitor = createSchemaDriftMonitor(fixture.rolePool('pipeline'), service, { now: () => now, intervalMs: 100 });
    await dropPolicy();
    await awaitTicket();
    monitor.stop();
    await expect.poll(async () => (await fixture.pool.query('SELECT claim_decision FROM oshal_alert_event')).rows[0]?.claim_decision).toBe('created');
    const ticket = (await ticketRows())[0];
    expect(ticket).toMatchObject({ status: 'approval_required', external_provider: 'schema-drift', owner_sub: 'alert:prometheus' });
    expect(ticket.description).toContain('scratch.schema_alarm_scratch: policies-changed; before: scratch_owner; after: none');
    expect(ticket.metadata.source).toBe('schema-drift');
    expect(ticket.labels).not.toContain('self-healing');
    await assertOperationsStream(ticket.ticket_id);
    expect((await fixture.pool.query('SELECT ticket_id FROM oshal_incident')).rows).toEqual([{ ticket_id: ticket.ticket_id }]);
    expect((await fixture.pool.query('SELECT claimed_by_rule, envelope_id, source FROM oshal_alert_event')).rows)
      .toEqual([{ claimed_by_rule: 'schema-drift', envelope_id: null, source: 'schema-drift' }]);
    const page = await operatorPage();
    try {
      const texts = await page.locator('#schemaDrift tbody td').allTextContents();
      expect(texts).toEqual(['scratch.schema_alarm_scratch', 'policies-changed', 'scratch_owner', 'none']);
      expect(await page.locator('#schemaDrift').getAttribute('open')).not.toBeNull();
      expect(await page.locator('#schemaDrift [data-drift-note]').innerText()).toContain('Detector: drift');
    } finally { await page.context().close(); }
    const restarted = createSchemaDriftMonitor(fixture.rolePool('pipeline'), service, { now: () => now, start: false });
    await restarted.tick();
    restarted.stop();
    expect((await fixture.pool.query('SELECT * FROM oshal_alert_event')).rows).toHaveLength(1);
    expect(await ticketRows()).toHaveLength(1);
  });

  it('requires confirmation and the reviewed fingerprint, and recapture updates the JSON baseline timestamp', async () => {
    await dropPolicy();
    const page = await operatorPage();
    try {
      page.once('dialog', (dialog) => { void dialog.dismiss(); });
      await page.locator('[data-drift-capture]').click();
      expect((await service.drift({ refresh: true })).report?.state).toBe('drift');
      page.once('dialog', (dialog) => { void dialog.accept(); });
      await page.locator('[data-drift-capture]').click();
      await page.waitForFunction(() => document.querySelector('#schemaDrift')?.getAttribute('data-state') === 'unchanged');
      expect(await page.locator('#schemaDrift tbody tr').count()).toBe(0);
      const body = await (await fetch(`${base}/api/admin/data-model/drift`, { headers: { cookie: 'test-user=fixture-operator' } })).json();
      const stale = await fetch(`${base}/api/admin/data-model/drift/baseline`, { method: 'POST',
        headers: { cookie: 'test-user=fixture-operator', 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true, fingerprint: '0'.repeat(64) }) });
      expect(stale.status).toBe(409);
      const unc = await fetch(`${base}/api/admin/data-model/drift/baseline`, { method: 'POST',
        headers: { cookie: 'test-user=fixture-operator', 'content-type': 'application/json' }, body: JSON.stringify({ fingerprint: body.digest.fingerprint }) });
      expect(unc.status).toBe(400);
      const captured = await service.drift({ capture: true, refresh: true });
      const latest = (await service.drift({ refresh: true })).baseline!;
      expect(latest.capturedAt).toBe(captured.digest!.capturedAt);
      await monitor.tick();
      expect(await ticketRows()).toHaveLength(0);
    } finally { await page.context().close(); }
  });

  it('honors the persisted disabled rule and never promotes a rule edited to automatic', async () => {
    await fixture.pool.query("UPDATE oshal_alert_claim_rule SET enabled = false WHERE rule_id = 'schema-drift'");
    await dropPolicy();
    await monitor.tick();
    await expect.poll(async () => (await fixture.pool.query('SELECT unclaimed_reason FROM oshal_alert_event')).rows[0]?.unclaimed_reason, { timeout: 15_000 }).toBe('rule_disabled');
    expect(await ticketRows()).toHaveLength(0);
    await fixture.pool.query("UPDATE oshal_alert_claim_rule SET enabled = true, intake = 'auto', autonomy_level = 'A2' WHERE rule_id = 'schema-drift'");
    await fixture.pool.query('ALTER TABLE schema_alarm_scratch DISABLE ROW LEVEL SECURITY');
    await monitor.tick();
    await awaitTicket();
    expect((await ticketRows())[0].status).toBe('approval_required');
    await fixture.pool.query('ALTER TABLE schema_alarm_scratch ENABLE ROW LEVEL SECURITY');
    await fixture.pool.query(readFileSync('scripts/migrations/165-schema-drift-claim.sql', 'utf8'));
    expect((await fixture.pool.query("SELECT autonomy_level FROM oshal_alert_claim_rule WHERE rule_id='schema-drift'")).rows[0].autonomy_level).toBe('A2');
  });

  it('keeps the schema source pending when the replay-only consumer excludes its lane', async () => {
    await dropPolicy();
    await monitor.tick();
    const replay = new EnvelopeStore(fixture.rolePool('pipeline'));
    const handled: string[] = [];
    await replay.withPendingEvents(100, async (events) => { handled.push(...events.map((event) => event.source)); }, ['schema-drift']);
    expect(handled).toEqual([]);
    await awaitTicket();
  });

  it('refuses anonymous/non-operator baseline changes and keeps other owners out of the real ticket', async () => {
    for (const [cookie, status] of [['', 401], ['test-user=unrelated', 403]] as const) {
      const response = await fetch(`${base}/api/admin/data-model/drift/baseline`, { method: 'POST',
        headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, fingerprint: 'a'.repeat(64) }) });
      expect(response.status).toBe(status);
    }
    await dropPolicy();
    await monitor.tick();
    await awaitTicket();
    expect((await fixture.rolePool('stranger').query('SELECT * FROM tickets')).rows).toEqual([]);
    expect((await fixture.rolePool('operator').query('SELECT * FROM tickets')).rows).toHaveLength(1);
  });

  it('does not let the schema seed rule change the unconfigured webhook replay default', async () => {
    const store = new EnvelopeStore(fixture.rolePool('pipeline'));
    const original = await store.landEnvelope({ source: 'alertmanager', signatureVerified: false,
      body: { alerts: [{ status: 'firing', fingerprint: 'external-fixture',
        labels: { alertname: 'ExternalFixture', instance: 'fixture-host', severity: 'warning' } }] } });
    const response = await fetch(`${base}/api/ops/alert-pipeline/replay`, { method: 'POST',
      headers: { cookie: 'test-user=fixture-operator', 'content-type': 'application/json' },
      body: JSON.stringify({ envelopeId: original.envelopeId }) });
    expect(response.status).toBe(200);
    expect((await fixture.pool.query("SELECT * FROM oshal_alert_event WHERE source='alertmanager' AND claim_decision IN ('created','consolidated','reopened')")).rows.length).toBeGreaterThan(0);
    await expect.poll(async () => Number((await fixture.pool.query("SELECT count(*) FROM oshal_alert_event WHERE claim_decision='pending'")).rows[0].count), { timeout: 15_000 }).toBe(0);
  });

  it('reuses the native ticket if intake must resume after its ticket write', async () => {
    await dropPolicy();
    await monitor.tick();
    await awaitTicket();
    const ticketId = (await ticketRows())[0].ticket_id;
    await fixture.pool.query("DELETE FROM oshal_alert_event_effect WHERE effect = 'intake'; UPDATE oshal_alert_event SET claim_decision='pending', processed_at=NULL");
    await awaitTicket();
    expect((await ticketRows())[0]).toMatchObject({ ticket_id: ticketId, status: 'approval_required', external_provider: 'schema-drift' });
    expect((await fixture.pool.query('SELECT claim_decision FROM oshal_alert_event')).rows[0].claim_decision).toBe('consolidated');
    expect((await fixture.pool.query('SELECT * FROM oshal_incident')).rows).toHaveLength(1);
  });
});
