/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guard fleet-default-provider-switch (the machine-write inventory entry of the same id points here): the fleet switch is ONE write from an operator browser session — PUT validates the id against the real catalog (400 with the reason and the accepted ids for an unknown one, nothing written), upserts the reserved row and refreshes the snapshot; DELETE clears it and refreshes; a service-secret caller is refused with 403 before any store call; a signed-in non-operator is refused; GET reports the row, the snapshot status and the accepted ids. The store is doubled here (its real companion is provider-switch-store-postgres.spec.ts on a disposable PostgreSQL as the enforcing role); the registry catalog is the real HARNESS_FACTORIES + provider-definitions.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | GET lists the per-bot rows (perBot, with updatedBy) beside the fleet row; DELETE /provider-switch/:scopeId releases a bot's own row back to the fleet default (removed:true, the fleet row reported, snapshot refreshed) and answers removed:false for an unknown scope. The per-bot WRITE stays on PUT /api/agents/:id/runtime (config-runtime-precedence.spec.ts): this router only lists and releases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createProviderSwitchRoutes } from '@/app/extensions/swarm/routes/provider-switch-routes';
import { HARNESS_FACTORIES } from '@/app/composition/provider-runtime';
import { buildProviderSwitchCatalog } from '@/app/composition/provider-switch-runtime';
import { ProviderSwitchSnapshot, type ProviderSwitchStore } from '@/features/agent-management';
import { FLEET_DEFAULT_SWITCH_ID, type ProviderSwitchRow } from '@/shared/llm-runtime';

let activeServer: Server | undefined;
let savedOperatorSubs: string | undefined;
let savedServiceSecret: string | undefined;
const OPERATOR = 'fleet-switch-operator';
const PERSON = 'fleet-switch-person';
const SECRET = 'fleet-switch-service-secret-for-this-spec-only';

beforeEach(() => {
  savedOperatorSubs = process.env.OSHAL_OPERATOR_SUBS;
  savedServiceSecret = process.env.SWARM_SERVICE_SECRET;
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  process.env.SWARM_SERVICE_SECRET = SECRET;
});

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve, reject) => { activeServer?.close((err) => (err ? reject(err) : resolve())); });
    activeServer = undefined;
  }
  if (savedOperatorSubs === undefined) delete process.env.OSHAL_OPERATOR_SUBS; else process.env.OSHAL_OPERATOR_SUBS = savedOperatorSubs;
  if (savedServiceSecret === undefined) delete process.env.SWARM_SERVICE_SECRET; else process.env.SWARM_SERVICE_SECRET = savedServiceSecret;
});

/** An in-memory store with the real store's surface; the Postgres companion proves the real one. */
function memoryStore(): { store: ProviderSwitchStore; rows: Map<string, ProviderSwitchRow>; upsert: ReturnType<typeof vi.fn> } {
  const rows = new Map<string, ProviderSwitchRow>();
  const upsert = vi.fn(async (scopeId: string, providerId: string, modelId: string | null, updatedBy: string) => {
    const row: ProviderSwitchRow = { scopeId, providerId, modelId, updatedBy, updatedAt: new Date().toISOString() };
    rows.set(scopeId, row);
    return row;
  });
  const store = {
    listAll: async () => Array.from(rows.values()),
    get: async (scopeId: string) => rows.get(scopeId) ?? null,
    upsert,
    remove: async (scopeId: string) => rows.delete(scopeId),
  } as unknown as ProviderSwitchStore;
  return { store, rows, upsert };
}

async function listen(
  store: ProviderSwitchStore | undefined,
  snapshot: ProviderSwitchSnapshot | null,
  identity: { sub: string } | null,
): Promise<string> {
  const catalog = buildProviderSwitchCatalog(Object.keys(HARNESS_FACTORIES));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (identity) {
      (req as typeof req & { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub: identity.sub } };
    }
    next();
  });
  app.use('/api/agents', createProviderSwitchRoutes({ store, snapshot: () => snapshot, catalog: () => catalog }));
  activeServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => activeServer?.once('listening', resolve));
  return `http://127.0.0.1:${(activeServer.address() as AddressInfo).port}/api/agents/provider-switch`;
}

function send(url: string, method: string, body?: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('fleet-default-provider-switch', () => {
  it("GET lists the bots that hold their own row and who wrote it; DELETE /:agentId releases that bot back to the fleet default", async () => {
    const BOT = 'a0000000-0000-0000-0000-000000000099';
    const CODEX_REGISTRY = { harnessType: 'codex-cli', apiType: 'openai-codex' };
    const { store, rows } = memoryStore();
    const snapshot = new ProviderSwitchSnapshot(store, buildProviderSwitchCatalog(Object.keys(HARNESS_FACTORIES)));
    const base = await listen(store, snapshot, { sub: OPERATOR });
    expect((await send(`${base}/fleet-default`, 'PUT', { providerId: 'codex-cli', modelId: 'gpt-5.5' })).status).toBe(200);
    // The per-bot row is written by PUT /api/agents/:id/runtime (config-runtime-precedence.spec.ts);
    // here it is already in the table, as that route leaves it.
    await store.upsert(BOT, 'gemini', 'gemini-3.8-flash', OPERATOR);
    await snapshot.refresh();
    expect(snapshot.resolve(BOT, CODEX_REGISTRY)).toMatchObject({ source: 'bot-row', providerId: 'gemini' });

    const read = await (await send(base, 'GET')).json();
    expect(read.fleetDefault).toMatchObject({ providerId: 'codex-cli' });
    expect(read.perBot).toEqual([expect.objectContaining({ scopeId: BOT, providerId: 'gemini', modelId: 'gemini-3.8-flash', updatedBy: OPERATOR })]);

    const released = await send(`${base}/${BOT}`, 'DELETE');
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({
      applied: true, removed: true, scopeId: BOT, fleetDefault: { providerId: 'codex-cli' }, snapshot: { rowCount: 1 },
    });
    expect(rows.has(BOT)).toBe(false);
    expect(snapshot.resolve(BOT, CODEX_REGISTRY)).toMatchObject({ source: 'fleet-default', providerId: 'codex-cli' });

    // An unknown scope removes nothing and says so; the fleet row is untouched.
    expect(await (await send(`${base}/no-such-bot`, 'DELETE')).json()).toMatchObject({ applied: true, removed: false, fleetDefault: { providerId: 'codex-cli' } });
    expect(snapshot.status()).toMatchObject({ rowCount: 1 });
  });

  it('the operator moves the fleet with ONE write; an unknown id is refused by name and nothing is written', async () => {
    const { store, rows, upsert } = memoryStore();
    const snapshot = new ProviderSwitchSnapshot(store, buildProviderSwitchCatalog(Object.keys(HARNESS_FACTORIES)));
    const base = await listen(store, snapshot, { sub: OPERATOR });

    const unknown = await send(`${base}/fleet-default`, 'PUT', { providerId: 'gemini-3.8-flash' });
    expect(unknown.status).toBe(400);
    const refusal = await unknown.json();
    expect(refusal).toMatchObject({ success: false, applied: false });
    expect(refusal.error).toMatch(/unknown provider id 'gemini-3.8-flash'/);
    expect(refusal.accepted).toEqual(expect.arrayContaining(['codex-cli', 'claude-code', 'gemini']));
    expect(upsert).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);

    // "switch the default" = one write, then the snapshot already answers from it.
    const written = await send(`${base}/fleet-default`, 'PUT', { providerId: 'codex-cli', modelId: 'gpt-5.5' });
    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({
      applied: true,
      fleetDefault: { scopeId: FLEET_DEFAULT_SWITCH_ID, providerId: 'codex-cli', modelId: 'gpt-5.5', updatedBy: OPERATOR },
      harnessType: 'codex-cli', apiType: 'openai-codex', botNodeRuntime: 'openai-codex',
      snapshot: { loaded: true, rowCount: 1 },
    });
    expect(snapshot.resolve('some-bot', { harnessType: 'claude-code', apiType: 'claude-code' }))
      .toMatchObject({ source: 'fleet-default', providerId: 'codex-cli', modelId: 'gpt-5.5' });

    const read = await send(base, 'GET');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ fleetDefault: { providerId: 'codex-cli' }, snapshot: { rowCount: 1 } });

    const cleared = await send(`${base}/fleet-default`, 'DELETE');
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ applied: true, removed: true, fleetDefault: null, snapshot: { rowCount: 0 } });
    expect(snapshot.resolve('some-bot', { harnessType: 'claude-code', apiType: 'claude-code' })).toMatchObject({ source: 'registry' });
  });

  it('a service-secret caller and a signed-in non-operator are both refused before any store call', async () => {
    const machine = memoryStore();
    const machineBase = await listen(machine.store, null, null);
    for (const [method, path, body] of [['PUT', '/fleet-default', { providerId: 'codex-cli' }], ['DELETE', '/fleet-default', undefined], ['GET', '', undefined]] as const) {
      const res = await send(`${machineBase}${path}`, method, body, { 'X-Service-Secret': SECRET });
      expect(res.status, `${method} ${path} with a service secret`).toBe(403);
    }
    expect(machine.upsert).not.toHaveBeenCalled();
    await new Promise<void>((resolve, reject) => { activeServer?.close((err) => (err ? reject(err) : resolve())); });
    activeServer = undefined;

    const person = memoryStore();
    const personBase = await listen(person.store, null, { sub: PERSON });
    const res = await send(`${personBase}/fleet-default`, 'PUT', { providerId: 'codex-cli' });
    expect(res.status).toBe(403);
    expect(person.upsert).not.toHaveBeenCalled();
  });

  it('with no Postgres pool every member answers 503, never a silent success', async () => {
    const base = await listen(undefined, null, { sub: OPERATOR });
    expect((await send(base, 'GET')).status).toBe(503);
    expect((await send(`${base}/fleet-default`, 'PUT', { providerId: 'codex-cli' })).status).toBe(503);
    expect((await send(`${base}/fleet-default`, 'DELETE')).status).toBe(503);
  });
});
