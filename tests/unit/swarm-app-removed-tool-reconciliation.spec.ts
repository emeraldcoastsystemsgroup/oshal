/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard active manifest updates: removed tools retire before upsert, grants are scoped and cannot be re-seeded during the update, shared/unchanged tools survive, cleanup failures abort, and activation failures roll back model privilege.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifest, SwarmAppService } from '@/features/swarm-apps';
import type { SwarmAppManifest, SwarmApplicationRecord } from '@/features/swarm-apps';

const APP = 'tool-reconcile-app';
const APP_BOT = 'cb000000-0000-0000-0000-000000000091';
const NEW_BOT = 'cb000000-0000-0000-0000-000000000092';
const OTHER_BOT = 'cb000000-0000-0000-0000-000000000093';
const tempDirs: string[] = [];

/** @description Build a valid package manifest with explicit bots and API tools. */
function manifestYaml(name: string, toolNames: string[], botIds = [APP_BOT]): string {
  const bots = botIds.flatMap((agentId, index) => [
    `  - agentId: ${agentId}`,
    `    name: ${name}-bot-${index}`,
    '    role: test/operator',
    '    persona: personas/test.yaml',
    '    capabilities: [test]',
  ]);
  const tools = toolNames.flatMap((toolName) => [
    `  - name: ${toolName}`,
    `    displayName: ${toolName}`,
    '    type: api',
    `    description: ${toolName}`,
    '    executor:',
    '      executorType: api',
    `      apiEndpoint: POST /api/test/${toolName}`,
  ]);
  return [
    `name: ${name}`,
    `displayName: ${name}`,
    'suite: ai-engineering',
    'status: active',
    'bots:',
    ...bots,
    ...(tools.length > 0 ? ['tools:', ...tools] : []),
    '',
  ].join('\n');
}

/** @description Write and parse one manifest, retaining its temp directory for cleanup. */
function writeManifest(name: string, tools: string[], bots = [APP_BOT]): string {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-tool-reconcile-'));
  tempDirs.push(dir);
  const path = join(dir, 'oshal-app.yaml');
  writeFileSync(path, manifestYaml(name, tools, bots), 'utf8');
  return path;
}

/** @description Shape a stored app record around a parsed manifest revision. */
function record(path: string, status: 'active' | 'inactive' = 'active'): SwarmApplicationRecord {
  const manifest = readManifest(path);
  const now = new Date();
  return {
    appId: manifest.name,
    name: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description ?? '',
    version: manifest.version ?? '0.0.0',
    status,
    manifestPath: path,
    agentIds: (manifest.bots ?? []).map((bot) => bot.agentId),
    toolNames: (manifest.tools ?? []).map((tool) => tool.name),
    manifest,
    scope: 'public',
    ownerSub: null,
    tenantId: null,
    guestTierApproved: null,
    loadedAt: now,
    updatedAt: now,
  };
}

const grantKey = (agentId: string, toolName: string) => `${agentId}|${toolName}`;

/** @description Minimal stateful pool for grant snapshot/delete behavior plus no-op activation SQL. */
class GrantPool {
  readonly grants = new Set<string>();
  readonly events: string[];
  readonly query = vi.fn(async (statement: string, params: unknown[] = []) => {
    const sql = String(statement);
    if (sql.includes('SELECT at.agent_id::text AS agent_id')) {
      const agentIds = new Set(params[0] as string[]);
      const toolNames = new Set(params[1] as string[]);
      const rows = [...this.grants]
        .map((key) => key.split('|'))
        .filter(([agentId, toolName]) => agentIds.has(agentId) && toolNames.has(toolName))
        .map(([agent_id, tool_name]) => ({ agent_id, tool_name }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('DELETE FROM agent_tools')) {
      this.deleteMatchingGrants(params, sql.includes('jsonb_to_recordset'));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  constructor(events: string[]) {
    this.events = events;
  }

  /** @description Apply either exact retired-name deletion or snapshot-preserving rollback. */
  private deleteMatchingGrants(params: unknown[], preservesSnapshot: boolean): void {
    const agentIds = new Set(params[0] as string[]);
    const toolNames = new Set(params[1] as string[]);
    const prior = preservesSnapshot
      ? new Set((JSON.parse(String(params[2])) as Array<{ agent_id: string; tool_name: string }>).map(
        (row) => grantKey(row.agent_id, row.tool_name),
      ))
      : new Set<string>();
    this.events.push(`delete:${[...toolNames].sort().join(',')}`);
    for (const key of [...this.grants]) {
      const [agentId, toolName] = key.split('|');
      if (agentIds.has(agentId) && toolNames.has(toolName) && !prior.has(key)) this.grants.delete(key);
    }
  }
}

/** @description In-memory repository that exposes ordering and persists manifest/status updates. */
class FakeRepo {
  readonly records = new Map<string, SwarmApplicationRecord>();
  readonly events: string[];
  upsertCalls = 0;

  constructor(initial: SwarmApplicationRecord[], events: string[]) {
    for (const item of initial) this.records.set(item.name, item);
    this.events = events;
  }

  async findByName(name: string) {
    this.events.push(`find:${name}`);
    return this.records.get(name) ?? null;
  }

  async list(status?: 'active' | 'inactive') {
    const records = [...this.records.values()];
    return status ? records.filter((item) => item.status === status) : records;
  }

  async upsert(manifest: SwarmAppManifest, manifestPath: string, toolNames: string[]) {
    this.events.push(`upsert:${manifest.name}`);
    this.upsertCalls += 1;
    const next = record(manifestPath);
    next.toolNames = toolNames;
    this.records.set(next.name, next);
    return next;
  }

  async updateStatus(name: string, status: 'active' | 'inactive') {
    const item = this.records.get(name);
    if (!item) return null;
    item.status = status;
    this.events.push(`status:${status}`);
    return item;
  }

  async delete(name: string) {
    return this.records.delete(name);
  }
}

interface HarnessOptions {
  otherRecords?: SwarmApplicationRecord[];
  deregisterFailure?: Error;
  seed?: (agentId: string, pool: GrantPool) => void;
}

/** @description Build the service with stateful grant and runtime-tool fakes. */
function harness(previous: SwarmApplicationRecord, options: HarnessOptions = {}) {
  const events: string[] = [];
  const pool = new GrantPool(events);
  const repo = new FakeRepo([previous, ...(options.otherRecords ?? [])], events);
  const deregisterRuntimeTool = vi.fn(async (toolName: string) => {
    events.push(`deregister:${toolName}`);
    if (options.deregisterFailure) throw options.deregisterFailure;
    return { removed: true, disabled: true };
  });
  const registerRuntimeTool = vi.fn(async (_tool: unknown, descriptor: { toolName: string }) => {
    events.push(`register:${descriptor.toolName}`);
    return {};
  });
  const seed = vi.fn(async (agentId: string) => {
    events.push(`seed:${agentId}`);
    options.seed?.(agentId, pool);
    return 1;
  });
  const service = new SwarmAppService(
    pool as never,
    repo as never,
    { updateAgentStatus: vi.fn(async () => undefined) } as never,
    { deregisterRuntimeTool, registerRuntimeTool, listRuntimeExecutors: vi.fn(async () => []) } as never,
    seed,
  );
  return { service, repo, pool, events, deregisterRuntimeTool, registerRuntimeTool, seed };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SwarmAppService removed-tool update reconciliation', () => {
  it('retires removed tools before upsert and deletes a stale grant re-seeded during activation', async () => {
    const previous = record(writeManifest(APP, ['retired-tool', 'kept-tool']));
    const incoming = writeManifest(APP, ['kept-tool']);
    const h = harness(previous, {
      seed: (agentId, pool) => pool.grants.add(grantKey(agentId, 'retired-tool')),
    });
    h.pool.grants.add(grantKey(APP_BOT, 'retired-tool'));
    h.pool.grants.add(grantKey(APP_BOT, 'kept-tool'));
    h.pool.grants.add(grantKey(OTHER_BOT, 'retired-tool'));

    await h.service.loadApp(incoming);

    expect(h.deregisterRuntimeTool).toHaveBeenCalledTimes(1);
    expect(h.deregisterRuntimeTool).toHaveBeenCalledWith('retired-tool', true);
    expect(h.pool.grants.has(grantKey(APP_BOT, 'retired-tool'))).toBe(false);
    expect(h.pool.grants.has(grantKey(APP_BOT, 'kept-tool'))).toBe(true);
    expect(h.pool.grants.has(grantKey(OTHER_BOT, 'retired-tool'))).toBe(true);
    expect(h.events.indexOf('deregister:retired-tool')).toBeLessThan(h.events.indexOf(`upsert:${APP}`));
    expect(h.events.lastIndexOf('delete:retired-tool')).toBeGreaterThan(h.events.indexOf(`seed:${APP_BOT}`));
  });

  it('does not tear down or delete grants for an unchanged tool', async () => {
    const previous = record(writeManifest(APP, ['kept-tool']));
    const incoming = writeManifest(APP, ['kept-tool']);
    const h = harness(previous);
    h.pool.grants.add(grantKey(APP_BOT, 'kept-tool'));

    await h.service.loadApp(incoming);

    expect(h.deregisterRuntimeTool).not.toHaveBeenCalled();
    expect(h.events).not.toContain('delete:kept-tool');
    expect(h.pool.grants.has(grantKey(APP_BOT, 'kept-tool'))).toBe(true);
  });

  it('retains another active app shared-name executor but removes only this app bot grant', async () => {
    const previous = record(writeManifest(APP, ['legacy-shared']));
    const incoming = writeManifest(APP, [], [NEW_BOT]);
    const survivor = record(writeManifest('surviving-provider', ['legacy-shared'], [OTHER_BOT]));
    const h = harness(previous, {
      otherRecords: [survivor],
      seed: (agentId, pool) => pool.grants.add(grantKey(agentId, 'legacy-shared')),
    });
    h.pool.grants.add(grantKey(APP_BOT, 'legacy-shared'));
    h.pool.grants.add(grantKey(OTHER_BOT, 'legacy-shared'));

    await h.service.loadApp(incoming);

    expect(h.deregisterRuntimeTool).not.toHaveBeenCalled();
    expect(h.pool.grants.has(grantKey(APP_BOT, 'legacy-shared'))).toBe(false);
    expect(h.pool.grants.has(grantKey(NEW_BOT, 'legacy-shared'))).toBe(false);
    expect(h.pool.grants.has(grantKey(OTHER_BOT, 'legacy-shared'))).toBe(true);
  });

  it('aborts before upsert when runtime cleanup fails while still attempting scoped grant deletion', async () => {
    const previous = record(writeManifest(APP, ['retired-tool']));
    const incoming = writeManifest(APP, []);
    const h = harness(previous, { deregisterFailure: new Error('runtime teardown failed') });
    h.pool.grants.add(grantKey(APP_BOT, 'retired-tool'));

    await expect(h.service.loadApp(incoming)).rejects.toThrow(/Removed-tool reconciliation failed/);

    expect(h.repo.upsertCalls).toBe(0);
    expect(h.registerRuntimeTool).not.toHaveBeenCalled();
    expect(h.pool.grants.has(grantKey(APP_BOT, 'retired-tool'))).toBe(false);
  });

  it('deactivates and rolls back newly seeded grants when a later activation step throws', async () => {
    const previous = record(writeManifest(APP, ['kept-tool']));
    const incoming = writeManifest(APP, ['kept-tool', 'added-tool']);
    const h = harness(previous, {
      seed: (agentId, pool) => pool.grants.add(grantKey(agentId, 'added-tool')),
    });
    h.pool.grants.add(grantKey(APP_BOT, 'kept-tool'));
    const mutable = h.service as unknown as { registerWorkflow: (manifest: SwarmAppManifest) => void };
    mutable.registerWorkflow = vi.fn(() => { throw new Error('late activation failure'); });

    await expect(h.service.loadApp(incoming)).rejects.toThrow(/late activation failure/);

    expect(h.repo.records.get(APP)?.status).toBe('inactive');
    expect(h.deregisterRuntimeTool).toHaveBeenCalledWith('added-tool', true);
    expect(h.pool.grants.has(grantKey(APP_BOT, 'added-tool'))).toBe(false);
    expect(h.pool.grants.has(grantKey(APP_BOT, 'kept-tool'))).toBe(true);
  });
});
