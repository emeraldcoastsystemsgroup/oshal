/**
 * Guard for the loadApp status-flip gap (BACKLOG, surfaced by the skill-profiles adversarial
 * review): a manifest edit that flips an app `active → inactive` and is re-loaded via
 * POST /api/swarm/apps/load used to call NEITHER activate() nor deactivate() — the row read
 * 'inactive' while the app's bots/workflow/registry entries stayed LIVE until a real
 * toggle-off. The guard asserts real teardown CALLS (bot-registry retraction, workflow
 * deregistration, agent-status writes) — not substrings — and that the boot path (loading an
 * already-inactive manifest fresh) stays a safe no-op.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Status-flip guard: loadApp on a resulting-inactive record performs the full deactivate teardown; fresh-inactive loads never activate.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmAppService } from '@/features/swarm-apps';
import { WorkflowPipelineRegistry } from '@/features/swarm-orchestration';

// ── fixtures ──────────────────────────────────────────────────────────────────

const APP = 'oshal-status-flip-fixture';
const TICKET = 'status-flip-ticket';
const BOT_ID = '0badf00d-0000-0000-0000-00000000f11b';

const tempDirs: string[] = [];

/** Write manifest YAML into a temp dir and return the file path. */
function writeManifest(body: string, dir?: string): string {
  const d = dir ?? mkdtempSync(join(tmpdir(), 'oshal-flip-'));
  if (!dir) tempDirs.push(d);
  const file = join(d, 'oshal-app.yaml');
  writeFileSync(file, body, 'utf8');
  return file;
}

function manifestYaml(status?: 'active' | 'inactive'): string {
  return [
    `name: ${APP}`,
    'displayName: Status Flip Fixture',
    'suite: ai-engineering',
    ...(status ? [`status: ${status}`] : []),
    `ticketType: ${TICKET}`,
    'workflow:',
    '  name: Status Flip Flow',
    '  pipeline: status-flip-flow',
    '  workerBot: flip-worker',
    'bots:',
    `  - agentId: ${BOT_ID}`,
    '    name: flip-worker',
    '    role: guard/worker',
    '    capabilities: [flipping]',
    '',
  ].join('\n');
}

/** In-memory repo faithful to the real upsert's status rule for this scenario: the manifest's
 *  declared status lands (EXCLUDED.status applies whenever the existing row is 'active'). */
class FakeRepo {
  readonly records = new Map<string, any>();

  async upsert(manifest: any, manifestPath: string, toolNames: string[]) {
    const prior = this.records.get(manifest.name);
    const declared = manifest.status ?? 'active';
    // Real repository precedence (non-variant): operator-applied inactive is preserved;
    // otherwise the manifest's declared status lands. Prior 'active' → declared wins.
    const status = prior && prior.status === 'inactive' ? 'inactive' : declared;
    const rec = {
      appId: manifest.name, name: manifest.name, displayName: manifest.displayName,
      description: manifest.description ?? '', version: manifest.version ?? '0.0.0',
      status, manifestPath,
      agentIds: (manifest.bots ?? []).map((b: any) => b.agentId),
      toolNames, manifest, scope: manifest.scope ?? 'public',
      ownerSub: null, tenantId: null, guestTierApproved: null,
      loadedAt: new Date(), updatedAt: new Date(),
    };
    this.records.set(manifest.name, rec);
    return rec;
  }

  async list(statusFilter?: 'active' | 'inactive') {
    const all = [...this.records.values()];
    return statusFilter ? all.filter((r) => r.status === statusFilter) : all;
  }

  async findByName(name: string) { return this.records.get(name) ?? null; }
  async updateStatus(name: string, status: 'active' | 'inactive') {
    const r = this.records.get(name);
    if (!r) return null;
    r.status = status;
    return r;
  }
  async delete(name: string) { return this.records.delete(name); }
}

const fakePool = { query: async () => ({ rows: [] as any[], rowCount: 0 }) };

interface Harness {
  svc: SwarmAppService;
  repo: FakeRepo;
  statusWrites: ReturnType<typeof vi.fn>;
  botRegistrar: { register: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn> };
}

function newHarness(): Harness {
  const repo = new FakeRepo();
  const statusWrites = vi.fn(async () => undefined);
  const botRegistrar = { register: vi.fn(), unregister: vi.fn() };
  const svc = new SwarmAppService(
    fakePool as any,
    repo as any,
    { updateAgentStatus: statusWrites } as any,
    undefined, // runtimeToolRegistrationService
    undefined, // personaAuthorizationSeeder
    undefined, // scheduleRegistrar
    undefined, // routeMounter
    undefined, // scheduleDeregistrar
    botRegistrar as any, // botRegistrar — the teardown call the gap left dangling
  );
  return { svc, repo, statusWrites, botRegistrar };
}

const registry = () => WorkflowPipelineRegistry.getInstance();

afterEach(() => {
  registry().unregisterApp(APP);
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── the guard ─────────────────────────────────────────────────────────────────

describe('SwarmAppService.loadApp — a status flip actually deactivates (BACKLOG gap)', () => {
  it('active → inactive manifest edit tears down the live registrations on re-load', async () => {
    const { svc, statusWrites, botRegistrar } = newHarness();
    const dir = mkdtempSync(join(tmpdir(), 'oshal-flip-'));
    tempDirs.push(dir);

    // 1. Load the ACTIVE manifest — bots register, workflow resolves.
    await svc.loadApp(writeManifest(manifestYaml(), dir));
    expect(botRegistrar.register).toHaveBeenCalledWith(APP, expect.any(Array));
    expect(registry().resolve(TICKET)?.workerBot).toBe('flip-worker');

    // 2. Edit the SAME manifest to status: inactive and re-load (the /load path).
    botRegistrar.unregister.mockClear();
    statusWrites.mockClear();
    const rec = await svc.loadApp(writeManifest(manifestYaml('inactive'), dir));
    expect(rec.status).toBe('inactive');

    // The gap: pre-fix, NONE of these teardown calls happened — the app read 'inactive'
    // while its bots/workflow stayed live. Assert the CALLS, not log text.
    expect(botRegistrar.unregister).toHaveBeenCalledWith(APP);
    expect(registry().resolve(TICKET)).toBeUndefined();
    expect(statusWrites).toHaveBeenCalledWith(BOT_ID, 'inactive');
  });

  it('a FRESH inactive manifest never activates (and the idempotent teardown does not throw)', async () => {
    const { svc, botRegistrar } = newHarness();

    const rec = await svc.loadApp(writeManifest(manifestYaml('inactive')));

    expect(rec.status).toBe('inactive');
    // Never activated: no bot registration, no workflow entry.
    expect(botRegistrar.register).not.toHaveBeenCalled();
    expect(registry().resolve(TICKET)).toBeUndefined();
  });

  it('the boot path stays safe: re-loading an already-inactive app is a repeatable no-op', async () => {
    const { svc, botRegistrar } = newHarness();
    const dir = mkdtempSync(join(tmpdir(), 'oshal-flip-'));
    tempDirs.push(dir);
    const path = writeManifest(manifestYaml('inactive'), dir);

    await svc.loadApp(path);
    await svc.loadApp(path); // second boot pass — deactivate is idempotent

    expect(botRegistrar.register).not.toHaveBeenCalled();
    expect(registry().resolve(TICKET)).toBeUndefined();
  });
});
