/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard explicit Twilio selection, default-off app setup, owner isolation and revoked-connection refusal.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Change Log brought to the standard block format. The pool is an in-memory double: the migration's RLS policy and SQL are not exercised here.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJarvisCallingConfigRoutes } from '@/app/routes/jarvis-calling-config-routes';

const ALICE = 'auth0|calling-alice';
const BOB = 'auth0|calling-bob';
const ALICE_CONNECTION = '11111111-1111-4111-8111-111111111111';
const BOB_CONNECTION = '22222222-2222-4222-8222-222222222222';
const SECOND_CONNECTION = '33333333-3333-4333-8333-333333333333';
const SHARED_CONNECTION = '44444444-4444-4444-8444-444444444444';
const HOUSEHOLD = '55555555-5555-4555-8555-555555555555';
type Connection = { id: string; owner: string; label: string; status: string; provider: string; tenantId?: string };
type Saved = { connection_id: string | null; enabled: boolean; transfer_phone: string | null; max_minutes: number; max_cost_cents: number; consented_at: string | null };
const connections: Connection[] = [];
const memberships = new Map<string, string[]>();
const saved = new Map<string, Saved>();
const sqlSeen: string[] = [];
const pool = {
  async query(sql: string, params: unknown[] = []) {
    sqlSeen.push(sql);
    if (sql.includes('FROM oshal_tenant_memberships')) {
      return { rows: (memberships.get(String(params[0])) || []).map((tenant_id) => ({ tenant_id })) };
    }
    if (sql.includes('FROM oshal_connections')) {
      return { rows: connections.filter((row) => row.provider === 'twilio' && row.status === 'connected'
        && (row.tenantId ? (params[1] as string[]).includes(row.tenantId) : row.owner === params[0]))
        .map((row) => ({ id: row.id, label: row.label, account_email: null, tenant_id: row.tenantId || null })) };
    }
    if (sql.includes('FROM jarvis_calling_settings')) {
      const row = saved.get(String(params[0]));
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('INSERT INTO jarvis_calling_settings')) {
      saved.set(String(params[0]), {
        connection_id: params[1] as string | null, enabled: params[2] as boolean,
        transfer_phone: params[3] as string | null, max_minutes: params[4] as number,
        max_cost_cents: params[5] as number, consented_at: params[2] ? new Date().toISOString() : null,
      });
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  },
};

describe('Jarvis calling application setup', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/jarvis/calling', createJarvisCallingConfigRoutes(pool as never, (req, res, next) => {
      const sub = req.get('x-test-sub');
      if (!sub) { res.status(401).json({ error: 'unauthorized' }); return; }
      (req as any).oidc = { user: { sub } };
      next();
    }));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  beforeEach(() => {
    connections.splice(0, connections.length,
      { id: ALICE_CONNECTION, owner: ALICE, label: 'My Twilio', provider: 'twilio', status: 'connected' },
      { id: SECOND_CONNECTION, owner: ALICE, label: 'Second Twilio', provider: 'twilio', status: 'connected' },
      { id: BOB_CONNECTION, owner: BOB, label: 'Bob Twilio', provider: 'twilio', status: 'connected' });
    saved.clear(); memberships.clear(); sqlSeen.length = 0;
  });
  async function get(sub = ALICE) {
    const response = await fetch(`${base}/api/jarvis/calling/config`, { headers: { 'x-test-sub': sub } });
    return { status: response.status, body: await response.json() };
  }
  async function put(data: Record<string, unknown>, sub = ALICE, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}/api/jarvis/calling/config`, {
      method: 'PUT', headers: {
        'x-test-sub': sub, 'content-type': 'application/json', origin: base,
        'x-oshal-calling-config': '1', ...headers,
      }, body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  }
  const configured = (connectionId: string | null = ALICE_CONNECTION, enabled = true) => ({
    connectionId, enabled, transferPhone: '+12025550123', maxMinutes: 15, maxCostCents: 300, consent: true,
  });

  it('starts off even when two Twilio connections already exist, without selecting either default', async () => {
    const result = await get();
    expect(result.body.config).toMatchObject({ connectionId: null, enabled: false, transferPhone: null });
    expect(result.body.connections.map((item: { id: string }) => item.id)).toEqual([ALICE_CONNECTION, SECOND_CONNECTION]);
    expect(result.body.effectiveEnabled).toBe(false);
    expect(result.body.blockedReasons).toContain('connection_not_selected');
    expect(sqlSeen.find((sql) => sql.includes('FROM oshal_connections'))).toContain("provider = 'twilio' AND status = 'connected'");
  });

  it('stores only an explicitly selected, accessible connection and opt-in', async () => {
    expect((await put(configured())).status).toBe(200);
    const result = await get();
    expect(result.body.config).toMatchObject({ connectionId: ALICE_CONNECTION, enabled: true, maxMinutes: 15, maxCostCents: 300, consented: true });
    expect(result.body.selectedConnectionAvailable).toBe(true);
    expect(result.body.effectiveEnabled).toBe(false);
    expect(result.body.blockedReasons).toEqual(['live_calling_not_installed']);
    expect((await put(configured(null, false))).body.config).toMatchObject({ connectionId: null, enabled: false, consented: false });
  });

  it('refuses missing consent, phone, selection, and another user’s connection', async () => {
    expect((await put({ ...configured(), consent: false })).status).toBe(400);
    expect((await put({ ...configured(), transferPhone: null })).status).toBe(400);
    expect((await put({ ...configured(), connectionId: null })).status).toBe(400);
    expect((await put(configured(BOB_CONNECTION))).body.error).toBe('twilio_connection_unavailable');
    expect(saved.size).toBe(0);
    expect((await get(BOB)).body.connections.map((item: { id: string }) => item.id)).toEqual([BOB_CONNECTION]);
  });

  it('never falls back when the chosen connection is revoked while another remains', async () => {
    await put(configured());
    connections[0].status = 'disconnected';
    const result = await get();
    expect(result.body.config.connectionId).toBe(ALICE_CONNECTION);
    expect(result.body.config.enabled).toBe(true);
    expect(result.body.connections).toHaveLength(1);
    expect(result.body.selectedConnectionAvailable).toBe(false);
    expect(result.body.blockedReasons).toContain('connection_unavailable');
    expect(result.body.effectiveEnabled).toBe(false);
  });

  it('requires separate per-user opt-in for an accessible shared connection and stops on lost membership', async () => {
    connections.push({ id: SHARED_CONNECTION, owner: BOB, label: 'Household Twilio',
      provider: 'twilio', status: 'connected', tenantId: HOUSEHOLD });
    memberships.set(ALICE, [HOUSEHOLD]);
    expect((await get()).body.connections).toContainEqual({ id: SHARED_CONNECTION, label: 'Household Twilio', scope: 'shared' });
    expect((await put(configured(SHARED_CONNECTION))).status).toBe(200);
    expect((await get(BOB)).body.config.enabled).toBe(false);
    memberships.delete(ALICE);
    const afterRemoval = await get();
    expect(afterRemoval.body.config.connectionId).toBe(SHARED_CONNECTION);
    expect(afterRemoval.body.selectedConnectionAvailable).toBe(false);
    expect(afterRemoval.body.effectiveEnabled).toBe(false);
  });

  it('requires authenticated same-origin JSON and bounds input', async () => {
    expect((await fetch(`${base}/api/jarvis/calling/config`)).status).toBe(401);
    expect((await put(configured(), ALICE, { origin: 'https://elsewhere.example' })).status).toBe(403);
    expect((await put({ ...configured(), transferPhone: '123' })).status).toBe(400);
    expect((await put({ ...configured(), maxCostCents: 100_000 })).status).toBe(400);
    expect((await put({ ...configured(), unexpected: true })).status).toBe(400);
  });

  it('serves the application setup screen and links it from Jarvis', async () => {
    const page = await fetch(`${base}/api/jarvis/calling/settings`, { headers: { 'x-test-sub': ALICE } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Connecting Twilio in Utilities does not turn calling on');
    const script = await fetch(`${base}/api/jarvis/calling/client.js`, { headers: { 'x-test-sub': ALICE } });
    expect(script.status).toBe(200);
    expect(await script.text()).toContain('X-Oshal-Calling-Config');
    const jarvis = readFileSync(path.resolve('src/api/jarvis.html'), 'utf8');
    expect(jarvis).toContain('/api/jarvis/calling/settings');
    const migration = readFileSync(path.resolve('scripts/migrations/168-jarvis-calling-settings.sql'), 'utf8');
    expect(migration).toContain('enabled BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
  });
});
