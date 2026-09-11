/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove fresh manifest load, durable runtime selection and real fixture dispatch with private PostgreSQL.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { Pool } from 'pg';
import yaml from 'js-yaml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SwarmAppService, SwarmAppRepository, readManifest, type SwarmAppManifest } from '@/features/swarm-apps';
import { AgentConfigService, BotNodeClient, createAgentConfigRuntimeParamsResolver } from '@/features/agent-management';
import { dispatchManifestWorkerTicket } from '@/features/swarm-orchestration/services/dispatch-manifest-worker';
import { seedManifestBotRuntime, upsertManifestBots, type ManifestBotRuntimeDefaultsResolver } from '@/features/swarm-apps/services/manifest-bot-runtime';
import type { InternalTicket } from '@/entities/ticket';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const fixture = new DisposableAlertPostgres();
let pool: Pool, root: string, server: Server | undefined;
const agentId = 'c8611746-2331-4eaa-b58c-21f0e4c5a601';
const defaults: ManifestBotRuntimeDefaultsResolver = providerId => ({ providerId: providerId ?? 'openai-native',
  ...(!providerId || providerId === 'openai-native' ? { modelId: 'fixture-deployment-model' } : {}) });
const migration = (name: string) => readFileSync(resolve('scripts/migrations', name), 'utf8');

function manifest(overrides: Partial<SwarmAppManifest> = {}): SwarmAppManifest {
  return { name: 'authority-fixture', displayName: 'Authority fixture', version: '1.0.0', status: 'active',
    bots: [{ agentId, name: 'authority-worker', container: 'fixture-node', harnessType: 'cline', apiType: 'openai-native', persona: 'persona.yaml' }], ...overrides };
}
function writePackage(input = manifest(), persona: unknown = { runtime: { harness: 'openai-native', model: 'fixture-persona-model' },
  selector_descriptor: 'Choose the package fixture', routing_keywords: ['package-authority'] }) {
  writeFileSync(join(root, 'persona.yaml'), yaml.dump(persona));
  const path = join(root, 'oshal-app.yaml'); writeFileSync(path, yaml.dump(input)); return path;
}
function service(resolveDefaults = defaults) {
  return new SwarmAppService(pool, new SwarmAppRepository(pool), {
    updateAgentStatus: async (id: string, status: string) => { await pool.query('UPDATE agents SET status=$2 WHERE agent_id=$1', [id, status]); },
  } as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, resolveDefaults);
}
async function values() { return (await new AgentConfigService(pool).getConfig(agentId))?.values; }

beforeAll(async () => {
  pool = await fixture.start();
  // Use the repository's actual schema, with no seeded bots, deployment DSN or external provider.
  for (const name of ['001-multi-agent-foundation.sql', '002-layer1-tools-framework.sql', '011-agent-config.sql',
    '022-swarm-applications.sql', '054-swarm-app-scope.sql', '076-app-guest-tier-approval.sql']) await pool.query(migration(name));
}, 120_000);
beforeEach(async () => {
  await pool.query('TRUNCATE agents, swarm_applications CASCADE');
  root = mkdtempSync(join(tmpdir(), 'oshal-manifest-authority-'));
  vi.stubEnv('APP_PACKAGE_MIGRATIONS', 'false'); vi.stubEnv('OSHAL_PUSH_ON_DISPATCH', '');
  vi.stubEnv('SWARM_SERVICE_SECRET', 'example-authority-fixture-secret');
});
afterEach(async () => {
  server?.closeAllConnections(); if (server) await new Promise<void>(done => server!.close(() => done())); server = undefined;
  const boundary = relative(resolve(tmpdir()), resolve(root));
  if (!boundary || boundary.startsWith('..')) throw new Error('Invalid temporary fixture cleanup');
  rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});
afterAll(async () => { await fixture.stop(); });

describe('Manifest bot authoritative runtime', () => {
  it('loads a clean package into real repositories and dispatches its persisted runtime over HTTP', async () => {
    const apps = service(); await apps.loadApp(writePackage());
    const resolver = createAgentConfigRuntimeParamsResolver(new AgentConfigService(pool));
    expect(await resolver(agentId)).toEqual({ providerId: 'openai-native', model: 'fixture-persona-model', configVersion: 1 });
    const row = (await pool.query('SELECT base_selector_descriptor, base_routing_keywords FROM agents WHERE agent_id=$1', [agentId])).rows[0];
    expect(row).toEqual({ base_selector_descriptor: 'Choose the package fixture', base_routing_keywords: ['package-authority'] });
    const calls: Record<string, unknown>[] = [];
    server = createServer((req, res) => {
      let body = ''; req.on('data', chunk => { body += String(chunk); }); req.on('end', () => {
        calls.push(JSON.parse(body) as Record<string, unknown>);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, response: 'fixture completed', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, cost: 0,
          model: 'fixture-persona-model', provider: 'openai-native', durationMs: 1 }));
      });
    });
    await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const botNodeClient = new BotNodeClient(id => id === agentId ? endpoint : null, 2_000, { env: {} });
    const updateStatus = vi.fn(async () => undefined);
    const ticket: InternalTicket = { ticketId: randomUUID(), ticketType: 'authority-fixture', title: 'Fixture dispatch', description: 'Verify saved selection',
      status: 'approved', stateGroup: 'active', executionPhase: null, priority: 'medium', labels: [], workspaceId: null, assignedAgentId: null,
      parentTicketId: null, externalProvider: null, externalId: null, externalUrl: null, metadata: {}, ownerSub: 'fixture-user',
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    let task: unknown = null;
    await dispatchManifestWorkerTicket(ticket, { ticketType: ticket.ticketType, name: 'Fixture', pipeline: 'manifest-worker', workerBot: 'authority-worker' }, {
      activeTicketIds: new Set(), dispatchStartTimes: new Map(), runtimeParamsResolver: resolver,
      resolveAgentIdByName: async name => (await pool.query('SELECT agent_id FROM agents WHERE name=$1', [name])).rows[0]?.agent_id,
      botNodeClient, ticketService: { updateStatus } as never, port: '1',
      taskStore: { get: async () => task, create: async (input: unknown) => { task = input; return input; },
        incrementMessageCount: async () => undefined, updateStatus: async () => undefined } as never,
      messageStore: { getByTask: async () => [], save: async (input: object) => ({ ...input, messageId: randomUUID(), createdAt: new Date().toISOString() }) } as never,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ agentId, providerConfigRequired: true, providerId: 'openai-native', model: 'fixture-persona-model', configVersion: 1 });
    expect(updateStatus).toHaveBeenCalledWith(ticket.ticketId, 'complete', expect.any(Object));
  });

  it('uses deployment defaults for an undeclared runtime and never invents a model for another provider', async () => {
    const input = manifest(); delete input.bots![0].apiType; delete input.bots![0].harnessType;
    await service().loadApp(writePackage(input, {}));
    expect(await values()).toEqual({ providerId: 'openai-native', modelId: 'fixture-deployment-model', configVersion: 1 });
    await pool.query('TRUNCATE agents, swarm_applications CASCADE');
    await service().loadApp(writePackage(manifest(), { runtime: { harness: 'anthropic' } }));
    expect(await values()).toEqual({ providerId: 'anthropic', configVersion: 1 });
  });

  it('preserves operator values, config schema and timestamp across reload and new service construction', async () => {
    const path = writePackage(); await service().loadApp(path);
    const config = new AgentConfigService(pool);
    const selected = { providerId: 'anthropic', modelId: 'operator-model', configVersion: 27, enabled: false, fixtureCredential: 'keep-fixture-value' };
    await config.setConfigValues(agentId, selected);
    await config.setConfigSchema(agentId, [{ name: 'fixtureCredential', type: 'string', label: 'Fixture' }] as never);
    const before = await config.getConfig(agentId);
    writePackage(manifest(), { runtime: { harness: 'openai-native', model: 'changed-package-model' } });
    await service().loadApp(path);
    expect(await config.getConfig(agentId)).toEqual(before);
    expect(await values()).toEqual(selected);
  });

  it('adopts a pre-existing agent provider/model instead of replacing them with package defaults', async () => {
    await pool.query('INSERT INTO agents(agent_id,name,api_provider_id,model_id) VALUES($1,$2,$3,$4)', [agentId, 'authority-worker', 'anthropic', 'saved-agent-model']);
    await service().loadApp(writePackage());
    expect(await values()).toEqual({ providerId: 'anthropic', modelId: 'saved-agent-model', configVersion: 1 });
  });

  it.each(['codex', 'codex-cli'])('normalizes the existing %s persona harness without enabling execution', async harness => {
    await service().loadApp(writePackage(manifest(), { runtime: { harness, model: 'fixture-codex-model', enabled: true, sandbox: 'danger-full-access' } }));
    expect(await values()).toEqual({ providerId: 'openai-codex', modelId: 'fixture-codex-model', configVersion: 1 });
  });

  it('creates one complete authoritative record when two initialization attempts race', async () => {
    await pool.query('INSERT INTO agents(agent_id,name,api_provider_id) VALUES($1,$2,$3)', [agentId, 'authority-worker', 'openai-native']);
    await Promise.all([seedManifestBotRuntime(pool, agentId, { providerId: 'openai-native', modelId: 'first-model' }),
      seedManifestBotRuntime(pool, agentId, { providerId: 'anthropic', modelId: 'second-model' })]);
    const rows = (await pool.query('SELECT config_values FROM agent_config WHERE agent_id=$1', [agentId])).rows;
    expect(rows).toHaveLength(1);
    expect([{ providerId: 'openai-native', modelId: 'first-model', configVersion: 1 },
      { providerId: 'anthropic', modelId: 'second-model', configVersion: 1 }]).toContainEqual(rows[0].config_values);
  });

  it.each(['', null])('preserves an explicit %s provider and reports no actionable runtime', async providerId => {
    const path = writePackage(); await service().loadApp(path);
    await pool.query('UPDATE agent_config SET config_values=$2 WHERE agent_id=$1', [agentId, { providerId, modelId: '', enabled: false }]);
    await service().loadApp(path);
    expect(await values()).toEqual({ providerId, modelId: '', enabled: false, configVersion: 1 });
    expect(await createAgentConfigRuntimeParamsResolver(new AgentConfigService(pool))(agentId)).toBeNull();
  });

  it('fills missing keys without attaching a package model to an existing different provider', async () => {
    const path = writePackage(); await service().loadApp(path);
    await pool.query('UPDATE agent_config SET config_values=$2 WHERE agent_id=$1', [agentId, { providerId: 'anthropic', enabled: false }]);
    await service().loadApp(path);
    expect(await values()).toEqual({ providerId: 'anthropic', enabled: false, configVersion: 1 });
  });

  it('preserves an operator update that commits while a seed is waiting for its row lock', async () => {
    await service().loadApp(writePackage());
    const client = await pool.connect();
    let pending: Promise<boolean> | undefined;
    try {
      await client.query('BEGIN'); await client.query('SELECT 1 FROM agent_config WHERE agent_id=$1 FOR UPDATE', [agentId]);
      pending = seedManifestBotRuntime(pool, agentId, { providerId: 'openai-native', modelId: 'stale-seed' });
      await vi.waitFor(async () => expect(Number((await pool.query("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO agent_config%'")).rows[0].count)).toBe(1));
      await client.query('UPDATE agent_config SET config_values=$2 WHERE agent_id=$1', [agentId, { providerId: 'anthropic', modelId: 'concurrent-choice', configVersion: 19 }]);
      await client.query('COMMIT'); await pending;
      expect(await values()).toEqual({ providerId: 'anthropic', modelId: 'concurrent-choice', configVersion: 19 });
    } finally { await client.query('ROLLBACK'); client.release(); await pending; }
  });

  it('rejects package persona escape and invalid declarations without inventing runtime values', async () => {
    const input = manifest(); input.bots![0].persona = '../outside-persona.yaml';
    await expect(service().loadApp(writePackage(input))).rejects.toThrow(/owning package/);
    expect((await pool.query('SELECT count(*) FROM agent_config')).rows[0].count).toBe('0');
    await pool.query('TRUNCATE swarm_applications');
    await expect(service().loadApp(writePackage(manifest(), { runtime: { harness: 'unregistered-provider' } }))).rejects.toThrow(/invalid runtime provider/);
  });

  it('keeps the application inactive when authority persistence fails', async () => {
    await pool.query('DROP TABLE agent_config');
    try {
      await expect(service().loadApp(writePackage())).rejects.toThrow(/agent_config/);
      expect((await pool.query('SELECT status FROM swarm_applications')).rows[0].status).toBe('inactive');
      expect((await pool.query('SELECT status FROM agents')).rows[0].status).toBe('inactive');
    } finally { await pool.query(migration('011-agent-config.sql')); }
  });

  it('fails closed when no declared or deployment provider exists', async () => {
    const input = manifest(); delete input.bots![0].apiType; delete input.bots![0].harnessType;
    await expect(service(() => undefined).loadApp(writePackage(input, {}))).rejects.toThrow(/no provider default/);
    expect((await pool.query('SELECT count(*) FROM agent_config')).rows[0].count).toBe('0');
  });

  it('retains a saved agent selection when deployment defaults are unavailable', async () => {
    await pool.query('INSERT INTO agents(agent_id,name,api_provider_id,model_id) VALUES($1,$2,$3,$4)', [agentId, 'authority-worker', 'anthropic', 'saved-model']);
    const input = manifest(); delete input.bots![0].apiType; delete input.bots![0].harnessType;
    await service(() => undefined).loadApp(writePackage(input, {}));
    expect(await values()).toEqual({ providerId: 'anthropic', modelId: 'saved-model', configVersion: 1 });
  });

  it('initializes every current kernel manifest bot from repository-relative personas in the disposable database', async () => {
    const ids = new Set<string>();
    for (const file of readdirSync(resolve('swarm-apps')).filter(name => name.endsWith('.yaml'))) {
      const path = resolve('swarm-apps', file), loaded = readManifest(path);
      await upsertManifestBots(pool, loaded, path, defaults);
      for (const bot of loaded.bots ?? []) ids.add(bot.agentId);
    }
    expect(ids.size).toBeGreaterThan(0);
    const resolver = createAgentConfigRuntimeParamsResolver(new AgentConfigService(pool));
    for (const id of ids) expect(await resolver(id)).toMatchObject({ providerId: expect.any(String), configVersion: 1 });
    expect(Number((await pool.query('SELECT count(*) FROM agent_config')).rows[0].count)).toBe(ids.size);
  });
});
