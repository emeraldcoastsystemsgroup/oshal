/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Vitest unit guards for the swarm-app manifest loader: readManifest fails closed on malformed fields; SwarmAppService.loadApp registers the manifest's ticketType/workflow/bots and is idempotent on a re-load; autoLoadAll isolates a bad manifest (logs + reports it, never aborts the boot pass). Previously exercised only via the docker-stack swarm-apps-framework e2e.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Drive the manifest-to-registry bridge instead of grepping it (CKR-1). registerWorkflow is a hand-written object literal that has already lost a field in production - reviewerBot was silently dropped, so every app-contributed reviewer bot fell through to graceful completion - and the guard that shipped for it was a source-text regex that never executed the bridge. Two cases now: a manifest declaring EVERY SwarmAppWorkflow key is loaded by the real service and every value is read back off the real registry, and a second case derives the key list from the INTERFACE and fails when the literal does not copy one, so a newly added field cannot be forgotten the same way twice.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | `pipeline: staged` is refused at load (CKR-10). Its executor was retired for the graph engine, so a manifest declaring it fell through to manifest-worker and ran only workerBot with every authored approval gate dropped and nothing logged. Two cases: staged throws naming graph, and the pipelines that DO have an executor still load - so the refusal cannot quietly become a blanket pipeline check. The every-key fixture also drops `stages`, which the manifest type no longer declares.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The CKR-10 still-loads case gives its `graph` fixture a processDefinition. CKR-11 refuses `pipeline: graph` without one - there is no graph to walk, so every such ticket escalates on arrival - and this case caught that interaction the moment the refusal landed, which is the case doing its job. It stays valuable because it is what proves the two narrow refusals did not widen into each other.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | The every-key fixture gives its processDefinition a nodeGraph. It previously held `nodes:` at the top level with no nodeGraph - an instance of the very shape CKR-11 refuses, since the engine walks nodeGraph and dispatchGraphTicket escalates without it. It loaded and the suite was green, which is how the guard set itself contained an example of the defect it was written to catch.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
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

describe('every declared workflow key survives the manifest-to-registry bridge', () => {
  const EVERY_KEY_APP = 'every-key-guard';
  const EVERY_KEY_TICKET = 'every-key-guard-ticket';

  afterEach(() => {
    registry().unregisterApp(EVERY_KEY_APP);
  });

  /**
   * The bridge is a hand-written object literal in swarm-app-service.registerWorkflow. It has
   * already lost a field in production: `reviewerBot` was silently dropped, which made every
   * app-contributed reviewer bot fall through to graceful completion. The guard that shipped for
   * that was a source-text regex over the file — it never executed the bridge, so it could only
   * ever catch the deletion of one literal string it was told to look for.
   *
   * This drives the REAL loader and reads the REAL registry, and it is derived from the type's
   * own key list, so a NEW field added to SwarmAppWorkflow and forgotten in the literal fails
   * here rather than being discovered in production a second time.
   */
  it('a manifest declaring every SwarmAppWorkflow key round-trips all of them', async () => {
    const svc = newService(new FakeRepo());
    const declared = {
      name: 'Every Key Flow',
      pipeline: 'graph',
      workerBot: 'guard-worker',
      reviewerBot: 'guard-reviewer',
      maxRevisions: 3,
      autoStart: true,
    };

    const manifest = [
      `name: ${EVERY_KEY_APP}`,
      'displayName: Every Key Guard',
      'suite: ai-engineering',
      `ticketType: ${EVERY_KEY_TICKET}`,
      'workflow:',
      `  name: ${declared.name}`,
      `  pipeline: ${declared.pipeline}`,
      `  workerBot: ${declared.workerBot}`,
      `  reviewerBot: ${declared.reviewerBot}`,
      `  maxRevisions: ${declared.maxRevisions}`,
      `  autoStart: ${declared.autoStart}`,
      '  processDefinition:',
      // Carries a nodeGraph because that is the key the ENGINE walks. This fixture used to hold
      // `nodes:` at the top level with no nodeGraph, which is the shape CKR-11's refusal now
      // catches - it would have loaded and then escalated at dispatch.
      '    nodeGraph:',
      '      nodes:',
      '        - id: start',
      '          type: task',
      'bots:',
      `  - agentId: ${VALID_BOT_ID}`,
      '    name: guard-worker',
      '    role: guard/worker',
      '    capabilities: [guarding]',
      '',
    ].join('\n');

    await svc.loadApp(writeManifest(manifest));
    const resolved = registry().resolve(EVERY_KEY_TICKET) as Record<string, unknown> | undefined;
    expect(resolved, 'the workflow never reached the registry at all').toBeTruthy();

    // Scalars, each asserted by VALUE — a key copied as `undefined` is the failure shape.
    for (const [key, value] of Object.entries(declared)) {
      expect(resolved?.[key], `workflow.${key} did not survive the bridge`).toEqual(value);
    }
    // The structured field, which a literal is just as capable of dropping.
    expect(resolved?.processDefinition, 'workflow.processDefinition did not survive the bridge')
      .toEqual({ nodeGraph: { nodes: [{ id: 'start', type: 'task' }] } });
  });

  it('the bridge copies every key the TYPE declares, so a new field cannot be forgotten', () => {
    // Derived from the interface, not from a list maintained here: the point of the original
    // defect is that someone added a field and did not touch the literal.
    const types = readFileSync(join(process.cwd(), 'src/features/swarm-apps/types.ts'), 'utf8');
    const body = types.slice(
      types.indexOf('export interface SwarmAppWorkflow {'),
      types.indexOf('}', types.indexOf('export interface SwarmAppWorkflow {')),
    );
    const declaredKeys = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(declaredKeys.length, 'parsed no keys off SwarmAppWorkflow - the parse is broken').toBeGreaterThan(5);

    const service = readFileSync(
      join(process.cwd(), 'src/features/swarm-apps/services/swarm-app-service.ts'), 'utf8',
    );
    const literal = service.match(/registerFromApp\(\s*manifest\.name,\s*\{[\s\S]*?\n\s*\}\s*\)/);
    expect(literal, 'registerFromApp literal not found').toBeTruthy();

    const missing = declaredKeys.filter((key) => !literal![0].includes(`manifest.workflow.${key}`));
    expect(missing, 'SwarmAppWorkflow declares these keys and the bridge copies none of them').toEqual([]);
  });
});

describe('a pipeline with no executor is refused, not quietly degraded', () => {
  it("readManifest refuses `pipeline: staged` and names the pipeline that works", () => {
    // The staged executor was retired for the graph engine. A manifest declaring it fell through
    // chooseDispatchPath to manifest-worker: only workerBot ran, every approval gate the author
    // wrote was dropped, and nothing was logged — a silently wrong run, which is worse than a
    // refused load. Publish is unaffected; the studio compiles its own staged authoring INTO a
    // graph and never emits this value.
    expect(() => readManifest(writeManifest([
      'name: staged-guard',
      'displayName: Staged Guard',
      'suite: ai-engineering',
      'ticketType: staged-guard-ticket',
      'workflow:',
      '  name: Staged Flow',
      '  pipeline: staged',
      '  workerBot: guard-worker',
      '',
    ].join('\n')))).toThrow(/graph/);
  });

  it('the pipelines that DO have an executor still load', () => {
    // The refusal must be specific to `staged`, not a blanket pipeline check.
    // `graph` carries a processDefinition here because CKR-11 refuses one without it: a graph
    // with no definition has nothing to walk and escalates on arrival. Both refusals are narrow,
    // and this case is what proves neither widened into the other.
    const GRAPH_DEFINITION = [
      '  processDefinition:',
      '    name: Fine',
      '    nodeGraph:',
      '      nodes:',
      '        - id: n-start',
      '          type: start',
      '      edges: []',
      '      topologicalOrder:',
      '        - n-start',
    ];
    for (const pipeline of ['graph', 'manifest-worker']) {
      expect(() => readManifest(writeManifest([
        `name: ok-${pipeline}`,
        'displayName: OK',
        'suite: ai-engineering',
        `ticketType: ok-${pipeline}-ticket`,
        'workflow:',
        '  name: Fine',
        `  pipeline: ${pipeline}`,
        '  workerBot: guard-worker',
        ...(pipeline === 'graph' ? GRAPH_DEFINITION : []),
        '',
      ].join('\n'))), `${pipeline} must still load`).not.toThrow();
    }
  });
});

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
