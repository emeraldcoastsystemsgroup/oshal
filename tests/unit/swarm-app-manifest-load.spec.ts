/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Vitest unit guards for the swarm-app manifest loader: readManifest fails closed on malformed fields; SwarmAppService.loadApp registers the manifest's ticketType/workflow/bots and is idempotent on a re-load; autoLoadAll isolates a bad manifest (logs + reports it, never aborts the boot pass). Previously exercised only via the docker-stack swarm-apps-framework e2e.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// autoLoadAll reads the manifest DIRECTORY via listManifestFiles(); mock only that so the pass
// runs against a controlled good+bad pair. readManifest stays REAL (importActual), so the
// fail-closed validation is genuinely exercised — the mock changes WHICH files, never how they parse.
const { listManifestFilesMock } = vi.hoisted(() => ({ listManifestFilesMock: vi.fn<[], string[]>(() => []) }));
vi.mock('@/features/swarm-apps/services/swarm-app-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/swarm-apps/services/swarm-app-loader')>();
  return { ...actual, listManifestFiles: listManifestFilesMock };
});

import { SwarmAppService, readManifest } from '@/features/swarm-apps';
import { WorkflowPipelineRegistry } from '@/features/swarm-orchestration';

// ── temp-file helpers ─────────────────────────────────────────────────────────

const tempDirs: string[] = [];

/** Write a full manifest YAML to a fresh temp dir and return its path. */
function writeManifest(yamlBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-manifest-'));
  tempDirs.push(dir);
  const file = join(dir, 'oshal-app.yaml');
  writeFileSync(file, yamlBody, 'utf8');
  return file;
}

/** Read a manifest whose body is appended to the required name/displayName preamble. */
function readBody(body: string) {
  return readManifest(writeManifest(`name: t\ndisplayName: T\n${body}`));
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── Part A: readManifest fails closed on malformed fields ───────────────────────

describe('readManifest — malformed manifests fail closed', () => {
  it('accepts a well-formed manifest (sanity — the guards are not vacuous)', () => {
    const m = readBody('suite: ai-engineering\n');
    expect(m.name).toBe('t');
    expect(m.suite).toBe('ai-engineering');
  });

  it('rejects an unknown suite (a typo must not invent a catalog shelf)', () => {
    expect(() => readBody('suite: not-a-real-suite\n')).toThrow(/not a known catalog suite/);
  });

  it('rejects a missing required field', () => {
    expect(() => readManifest(writeManifest('name: only-name\n'))).toThrow(/missing required fields/);
  });

  it('rejects a present-but-empty bots array (a typo\'d bots: key is a mistake worth failing on)', () => {
    expect(() => readBody('bots: []\n')).toThrow(/bots, when present, must be a non-empty array/);
  });

  it('rejects a bot that declares harnessType without apiType (incomplete runtime pair)', () => {
    expect(() =>
      readBody('bots:\n  - agentId: b1\n    name: half-declared\n    harnessType: claude-code\n'),
    ).toThrow(/must declare harnessType and apiType together/);
  });

  it('rejects an incompatible harness/api pair', () => {
    expect(() =>
      readBody('bots:\n  - agentId: b1\n    name: mismatched\n    harnessType: claude-code\n    apiType: google-gemini\n'),
    ).toThrow(/incompatible/);
  });

  it('rejects a malformed skillProfiles (a list where a capability→profile map is required)', () => {
    expect(() => readBody('skillProfiles:\n  - not: a-map\n')).toThrow(/skillProfiles, when present, must be a map/);
  });
});

// ── Part B / C: SwarmAppService orchestration with in-memory fakes ──────────────

/** Minimal in-memory stand-in for SwarmAppRepository — faithful to rowToRecord's shape and to
 *  upsert's agent_ids = manifest.bots[].agentId contract. Keyed by name like the real table. */
class FakeRepo {
  readonly records = new Map<string, any>();

  async upsert(manifest: any, manifestPath: string, toolNames: string[]) {
    const agentIds = (manifest.bots ?? []).map((b: any) => b.agentId);
    const now = new Date();
    const rec = {
      appId: manifest.name,
      name: manifest.name,
      displayName: manifest.displayName,
      description: manifest.description ?? '',
      version: manifest.version ?? '0.0.0',
      status: manifest.status ?? 'active',
      manifestPath,
      agentIds,
      toolNames,
      manifest,
      scope: manifest.scope ?? 'public',
      ownerSub: null,
      tenantId: null,
      guestTierApproved: null,
      loadedAt: now,
      updatedAt: now,
    };
    this.records.set(manifest.name, rec);
    return rec;
  }

  async list(statusFilter?: 'active' | 'inactive') {
    const all = [...this.records.values()];
    return statusFilter ? all.filter((r) => r.status === statusFilter) : all;
  }

  async findByName(name: string) {
    return this.records.get(name) ?? null;
  }

  async updateStatus(name: string, status: 'active' | 'inactive') {
    const r = this.records.get(name);
    if (!r) return null;
    r.status = status;
    return r;
  }

  async delete(name: string) {
    return this.records.delete(name);
  }
}

/** Pool whose queries are all no-ops (upsertBots + reconcile write to the agents table). */
const fakePool = { query: async () => ({ rows: [] as any[], rowCount: 0 }) };
const fakeAgentProfileRepo = { updateAgentStatus: async () => undefined };

function newService(repo: FakeRepo): SwarmAppService {
  return new SwarmAppService(fakePool as any, repo as any, fakeAgentProfileRepo as any);
}

const registry = () => WorkflowPipelineRegistry.getInstance();

const VALID_APP = 'oshal-critical-guard-fixture';
const VALID_TICKET = 'critical-guard-ticket';
const VALID_BOT_ID = '0badf00d-0000-0000-0000-000000000001';

function validManifestYaml(): string {
  return [
    `name: ${VALID_APP}`,
    'displayName: Critical Guard Fixture',
    'suite: ai-engineering',
    `ticketType: ${VALID_TICKET}`,
    'workflow:',
    '  name: Critical Guard Flow',
    '  pipeline: critical-guard-flow',
    '  workerBot: guard-worker',
    'bots:',
    `  - agentId: ${VALID_BOT_ID}`,
    '    name: guard-worker',
    '    role: guard/worker',
    '    capabilities: [guarding]',
    '',
  ].join('\n');
}

describe('SwarmAppService.loadApp — registers ticketType/workflow/bots', () => {
  afterEach(() => {
    registry().unregisterApp(VALID_APP);
  });

  it('a valid manifest activates its bots and registers its workflow into the pipeline registry', async () => {
    const repo = new FakeRepo();
    const svc = newService(repo);

    const rec = await svc.loadApp(writeManifest(validManifestYaml()));

    // Bots: the record associates the manifest's declared agent, active.
    expect(rec.status).toBe('active');
    expect(rec.agentIds).toContain(VALID_BOT_ID);

    // Workflow: the app's ticketType now resolves to its declared worker + pipeline.
    const wf = registry().resolve(VALID_TICKET);
    expect(wf).toBeDefined();
    expect(wf!.workerBot).toBe('guard-worker');
    expect(wf!.pipeline).toBe('critical-guard-flow');
  });

  it('a duplicate load is idempotent — one workflow entry, one record, no drift', async () => {
    const repo = new FakeRepo();
    const svc = newService(repo);
    const manifestPath = writeManifest(validManifestYaml());

    await svc.loadApp(manifestPath);
    const second = await svc.loadApp(manifestPath);

    // registerFromApp replaces by ticketType, so a re-load must not accumulate entries.
    const appEntries = registry()
      .listAll()
      .filter((e) => e.source === 'app' && e.appName === VALID_APP);
    expect(appEntries).toHaveLength(1);

    // The repo upsert stays keyed by name — one record, agent association preserved.
    expect(repo.records.size).toBe(1);
    expect(second.agentIds).toEqual([VALID_BOT_ID]);
    expect(registry().resolve(VALID_TICKET)?.workerBot).toBe('guard-worker');
  });
});

describe('SwarmAppService.autoLoadAll — a bad manifest is isolated, not fatal', () => {
  const GOOD_APP = 'oshal-autoload-good-fixture';

  afterEach(() => {
    listManifestFilesMock.mockReset();
    registry().unregisterApp(GOOD_APP);
  });

  it('loads the valid manifest and reports the invalid one under failed[] without throwing', async () => {
    const goodPath = writeManifest(
      [
        `name: ${GOOD_APP}`,
        'displayName: Autoload Good',
        'suite: ai-engineering',
        'bots:',
        '  - agentId: 0badf00d-0000-0000-0000-000000000002',
        '    name: autoload-good-worker',
        '    role: r',
        '    capabilities: [x]',
        '',
      ].join('\n'),
    );
    // Fails readManifest (unknown suite) — the fail-closed path autoLoadAll must catch.
    const badPath = writeManifest('name: oshal-autoload-bad-fixture\ndisplayName: Autoload Bad\nsuite: not-a-real-suite\n');

    listManifestFilesMock.mockReturnValue([goodPath, badPath]);

    const repo = new FakeRepo();
    const svc = newService(repo);

    const result = await svc.autoLoadAll();

    expect(result.loaded).toContain(GOOD_APP);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].path).toBe(badPath);
    expect(result.failed[0].error).toMatch(/not a known catalog suite/);
    // The good app still landed despite its sibling failing — boot is not aborted.
    expect(repo.records.has(GOOD_APP)).toBe(true);
  });
});
