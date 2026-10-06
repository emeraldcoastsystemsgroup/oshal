/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081 guards: apps cannot take over the privileged developer lane. The pipeline registry refuses a workflow claiming 'oshal-dev' from any app but its owner (so the gated manifest-worker lane is never replaced by a graph pipeline) and a workflow for another type that names the developer bot anywhere (workerBot, reviewerBot, a graph node binding, any letter case); the publish compiler refuses the same at publish; the dispatch gates escalate superadmin_required, terminally, for a ticket that would reach the developer bot through a pin, a declared worker or a graph binding unless its type is privileged and its owner a super-admin, and the real manifest-worker branch sends it nothing; the legitimate oshal-dev lane still dispatches for a super-admin. Review round 2: the alias takeover (a manifest declaring the developer bot's id under another name, so its agents row is renamed and a graph workflow names the alias) is refused at publish, at manifest read and at the bot upsert; the graph engine judges the RESOLVED id before every dispatch; the registry refuses any pipeline but manifest-worker even from the owner app; the real poll cycle escalates a non-super-admin's privileged ticket before any branch and leaves a build ticket's PM assignment to the lane, which reroutes it. Each fails on the tree before the fix.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateInternalTicketSchema } from '@/entities/ticket';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { readManifest } from '@/features/swarm-apps/services/swarm-app-loader';
import { upsertManifestBots } from '@/features/swarm-apps/services/manifest-bot-runtime';
import { compileWorkflowSpec } from '@/features/swarm-apps/services/workflow-publish-compiler';
import { EngineServicesAdapter } from '@/features/swarm-orchestration/services/engine-services-adapter';
import { QueueManagerService } from '@/features/swarm-orchestration/services/queue-manager-service';
import { WorkflowPipelineRegistry } from '@/features/swarm-orchestration/services/workflow-pipeline-registry';
import { BUILT_IN_TICKET_TYPES, chooseDispatchPath } from '@/features/swarm-orchestration/services/dispatch-routing';
import { refusePrivilegedDispatch, refuseTicketAtDispatch } from '@/features/swarm-orchestration/services/dispatch-ticket-gates';
import { dispatchManifestWorkerTicket } from '@/features/swarm-orchestration/services/dispatch-manifest-worker';
import { isPrivilegedWorkerAgent, privilegedManifestRefusal, privilegedWorkflowRefusal, workflowNamedWorkers } from '@/shared/middleware/superadmin';

const DEV_BOT = 'de000000-0000-0000-0000-000000000001';
const SUPERADMIN = 'person-developer-sub';
const PERSON = 'person-user-sub';
/** The oshal-dev lane as swarm-apps/oshal-dev.yaml registers it. */
const OSHAL_DEV_LANE = { ticketType: 'oshal-dev', name: 'OSHAL Platform Development', pipeline: 'manifest-worker', workerBot: 'oshal-developer' };
/** A graph process definition whose one agent node binds the developer bot. */
const graphBinding = (binding: string) => ({
  name: 'Tweak', nodeGraph: { nodes: [{ id: 'n1', type: 'execute-agent', title: 'Run', config: { agentBinding: binding, workType: 'authored' } }], edges: [], topologicalOrder: ['n1'] },
});

const registry = WorkflowPipelineRegistry.getInstance();
const registered: string[] = [];
/** Registers through the real registry and remembers the app for cleanup. */
function register(appName: string, workflow: Record<string, unknown>): boolean {
  registered.push(appName);
  return registry.registerFromApp(appName, { name: appName, pipeline: 'manifest-worker', workerBot: 'general-bot', ...workflow } as never);
}

beforeEach(() => {
  vi.stubEnv('OSHAL_SUPERADMIN_SUBS', SUPERADMIN);
  vi.stubEnv('SWARM_SERVICE_SECRET', 'placeholder-service-secret-spec');
});
afterEach(() => {
  for (const appName of registered.splice(0)) registry.unregisterApp(appName);
  vi.unstubAllEnvs();
});

describe('the privileged worker is named once, in shared/middleware/superadmin', () => {
  it('isPrivilegedWorkerAgent matches the developer bot by id or name, in any letter case, and nothing else', () => {
    for (const value of [DEV_BOT, DEV_BOT.toUpperCase(), ` ${DEV_BOT} `, 'oshal-developer', 'OSHAL-Developer']) expect(isPrivilegedWorkerAgent(value), value).toBe(true);
    for (const value of ['general-bot', 'a0000000-0000-0000-0000-000000000002', '', null, undefined]) expect(isPrivilegedWorkerAgent(value), String(value)).toBe(false);
  });

  it('workflowNamedWorkers collects the workerBot, the reviewerBot and every binding inside the process definition', () => {
    expect(workflowNamedWorkers({ workerBot: 'a', reviewerBot: 'b', processDefinition: graphBinding('c') })).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(workflowNamedWorkers({ workerBot: 'a' })).toEqual(['a']);
    expect(workflowNamedWorkers(undefined)).toEqual([]);
  });

  it('privilegedWorkflowRefusal lets only the oshal-dev app register oshal-dev, and no other type name the developer bot', () => {
    expect(privilegedWorkflowRefusal({ appName: 'oshal-dev', ticketType: 'oshal-dev', workers: ['oshal-developer'] })).toBeNull();
    expect(privilegedWorkflowRefusal({ appName: 'devtweak', ticketType: 'oshal-dev', workers: ['general-bot'] })).toMatch(/privileged/);
    expect(privilegedWorkflowRefusal({ appName: 'tweaks', ticketType: 'platform-tweak', workers: ['general-bot', DEV_BOT.toUpperCase()] })).toMatch(/privileged worker/);
    expect(privilegedWorkflowRefusal({ appName: 'tweaks', ticketType: 'platform-tweak', workers: ['general-bot'] })).toBeNull();
  });
});

describe('the pipeline registry refuses a takeover of the privileged lane', () => {
  it("refuses 'oshal-dev' from any app but its owner, so a graph pipeline never replaces the gated lane", () => {
    expect(register('devtweak', { ticketType: 'oshal-dev', pipeline: 'graph', workerBot: 'oshal-developer', processDefinition: graphBinding('oshal-developer') })).toBe(false);
    expect(registry.resolve('oshal-dev')).toBeUndefined();
    // Even the owner app registers only the manifest-worker pipeline, the one whose gate checks the owner.
    expect(register('oshal-dev', { ...OSHAL_DEV_LANE, pipeline: 'graph', processDefinition: graphBinding('oshal-developer') })).toBe(false);
    expect(registry.resolve('oshal-dev')).toBeUndefined();
    expect(register('oshal-dev', OSHAL_DEV_LANE)).toBe(true);
    expect(register('devtweak', { ticketType: 'oshal-dev', pipeline: 'graph', workerBot: 'oshal-developer' })).toBe(false);
    const lane = registry.resolve('oshal-dev');
    expect(lane?.pipeline).toBe('manifest-worker');
    expect(chooseDispatchPath('oshal-dev', lane, new Set(BUILT_IN_TICKET_TYPES))).toBe('manifest-worker');
  });

  it('refuses a workflow for another type that names the developer bot as its worker, reviewer or a graph binding', () => {
    expect(register('tweaks-a', { ticketType: 'platform-tweak', workerBot: 'oshal-developer' })).toBe(false);
    expect(register('tweaks-b', { ticketType: 'platform-tweak', workerBot: 'OSHAL-Developer' })).toBe(false);
    expect(register('tweaks-c', { ticketType: 'platform-tweak', workerBot: 'general-bot', reviewerBot: DEV_BOT })).toBe(false);
    expect(register('tweaks-d', { ticketType: 'platform-tweak', pipeline: 'graph', workerBot: 'general-bot', processDefinition: graphBinding(DEV_BOT.toUpperCase()) })).toBe(false);
    expect(registry.resolve('platform-tweak')).toBeUndefined();
    // An ordinary app workflow still registers.
    expect(register('tweaks-e', { ticketType: 'platform-tweak', workerBot: 'general-bot' })).toBe(true);
    expect(registry.resolve('platform-tweak')?.workerBot).toBe('general-bot');
  });
});

describe('the publish compiler refuses the same at publish (POST /api/swarm/apps/publish answers 400)', () => {
  it("refuses a workflow claiming 'oshal-dev', whatever its name or mode", () => {
    expect(() => compileWorkflowSpec({ name: 'devtweak', mode: 'single-shot', ticketType: 'oshal-dev', workerBot: 'general-bot' } as never, 'public')).toThrow(/privileged/);
    expect(() => compileWorkflowSpec({ name: 'oshal-dev', mode: 'single-shot', workerBot: 'general-bot' } as never, 'public')).toThrow(/privileged/);
    expect(() => compileWorkflowSpec({ name: 'devtweak', mode: 'staged', ticketType: 'oshal-dev', stages: [{ bot: 'general-bot' }] } as never, 'person')).toThrow(/privileged/);
  });

  it('refuses a workflow that names the developer bot in a stage, and compiles an ordinary one', () => {
    expect(() => compileWorkflowSpec({ name: 'tweak', mode: 'single-shot', workerBot: 'oshal-developer' } as never, 'person')).toThrow(/privileged worker/);
    expect(() => compileWorkflowSpec({ name: 'tweak', mode: 'staged', stages: [{ bot: 'general-bot' }, { bot: DEV_BOT.toUpperCase() }] } as never, 'person')).toThrow(/privileged worker/);
    const manifest = compileWorkflowSpec({ name: 'tweak', mode: 'single-shot', workerBot: 'general-bot' } as never, 'person');
    expect(manifest).toMatchObject({ name: 'tweak', ticketType: 'tweak', workflow: { pipeline: 'graph', workerBot: 'general-bot' } });
  });
});

describe('the dispatch gates: a privileged worker is reached only by a privileged type owned by a super-admin', () => {
  const refused = { reason: 'superadmin_required', source: 'queue-manager-dispatch' };

  it("escalates an 'oshal-dev' ticket of a non-super-admin on every pipeline, and admits a super-admin's", () => {
    const graphLane = { ...OSHAL_DEV_LANE, pipeline: 'graph', processDefinition: graphBinding('oshal-developer') };
    expect(refusePrivilegedDispatch({ ticketType: 'oshal-dev', ownerSub: PERSON, workflow: graphLane, metadata: {} })?.escalation).toMatchObject(refused);
    expect(refusePrivilegedDispatch({ ticketType: 'oshal-dev', ownerSub: PERSON, workflow: OSHAL_DEV_LANE, metadata: {} })?.escalation).toMatchObject(refused);
    expect(refusePrivilegedDispatch({ ticketType: 'oshal-dev', ownerSub: null, workflow: OSHAL_DEV_LANE, metadata: {} })?.escalation).toMatchObject(refused);
    expect(refusePrivilegedDispatch({ ticketType: 'oshal-dev', ownerSub: SUPERADMIN, workflow: OSHAL_DEV_LANE, metadata: {} })).toBeNull();
  });

  it('escalates any other type whose workflow or metadata would reach the developer bot, even for a super-admin', () => {
    expect(refusePrivilegedDispatch({ ticketType: 'platform-tweak', ownerSub: SUPERADMIN, workflow: { workerBot: 'oshal-developer' }, metadata: {} })?.escalation).toMatchObject(refused);
    expect(refusePrivilegedDispatch({ ticketType: 'reports', ownerSub: SUPERADMIN, workflow: { workerBot: 'general-bot', processDefinition: graphBinding(DEV_BOT) }, metadata: {} })?.escalation).toMatchObject(refused);
    expect(refusePrivilegedDispatch({ ticketType: 'task', ownerSub: SUPERADMIN, workflow: { workerBot: 'general-bot' }, metadata: { targetAgentId: ` ${DEV_BOT.toUpperCase()} ` } })?.escalation).toMatchObject(refused);
    // A PM assignment is a routing hint the swarm lane drops and reroutes (routablePmAssignment); the gate leaves it alone.
    expect(refusePrivilegedDispatch({ ticketType: 'build', ownerSub: PERSON, workflow: undefined, metadata: { pmAssignedAgentId: DEV_BOT } })).toBeNull();
    // Ordinary dispatches are untouched.
    expect(refusePrivilegedDispatch({ ticketType: 'task', ownerSub: PERSON, workflow: { workerBot: 'general-bot' }, metadata: { targetAgentId: 'a0000000-0000-0000-0000-000000000099' } })).toBeNull();
    expect(refusePrivilegedDispatch({ ticketType: 'build', ownerSub: PERSON, workflow: undefined, metadata: null })).toBeNull();
  });

  it("the manifest-worker gate judges the declared workers beside the pin, and admits the lane's own declared worker", () => {
    expect(refuseTicketAtDispatch({ ticketType: 'task', ownerSub: SUPERADMIN, workers: ['general-bot', 'oshal-developer'] })?.escalation.reason).toBe('superadmin_required');
    expect(refuseTicketAtDispatch({ ticketType: 'task', ownerSub: SUPERADMIN, pinnedAgentId: DEV_BOT })?.escalation.reason).toBe('superadmin_required');
    expect(refuseTicketAtDispatch({ ticketType: 'oshal-dev', ownerSub: SUPERADMIN, workers: ['oshal-developer'] })).toBeNull();
    // A pin on the lane's own ticket passes the privileged rule and then meets the ordinary Z-08 pin entitlement, as before.
    expect(refuseTicketAtDispatch({ ticketType: 'oshal-dev', ownerSub: SUPERADMIN, pinnedAgentId: DEV_BOT, workers: ['oshal-developer'] })?.escalation.reason).toBe('pinned_agent_not_entitled');
  });
});

/** A bot-node stub that records every dispatch it receives. */
async function withStub(body: (port: string, posts: Array<Record<string, unknown>>) => Promise<void>): Promise<void> {
  const posts: Array<Record<string, unknown>> = [];
  const stub = express();
  stub.use(express.json());
  stub.use((req, res) => { posts.push(req.body as Record<string, unknown>); res.json({ success: true, response: 'stub reply' }); });
  const server = stub.listen(0, 'localhost');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try { await body(String((server.address() as AddressInfo).port), posts); } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('the real manifest-worker branch', () => {
  const ticketOf = (ticketType: string, ownerSub: string) => ({
    ticketId: `tix-${ticketType}`, title: 'Edit the router', description: 'change src/ and push', ticketType,
    status: 'approved', priority: 'medium', labels: [], ownerSub, metadata: {},
  });
  const depsOn = (port: string) => {
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    return {
      updateStatus,
      deps: {
        activeTicketIds: new Set<string>(), dispatchStartTimes: new Map<string, number>(), port,
        resolveAgentIdByName: vi.fn(async (name: string) => (name === 'oshal-developer' ? DEV_BOT : undefined)),
        ticketService: { updateStatus, linkTask: vi.fn().mockResolvedValue(undefined), getTasksForTicket: vi.fn().mockResolvedValue([]) },
      },
    };
  };

  it('sends nothing to the developer bot for an app type that declares it, and escalates terminally', async () => {
    await withStub(async (port, posts) => {
      const { deps, updateStatus } = depsOn(port);
      const workflow = { ticketType: 'platform-tweak', name: 'Platform tweak', pipeline: 'manifest-worker', workerBot: 'oshal-developer' };
      await dispatchManifestWorkerTicket(ticketOf('platform-tweak', SUPERADMIN) as never, workflow as never, deps as never);
      expect(posts).toEqual([]);
      expect(updateStatus).toHaveBeenCalledWith('tix-platform-tweak', 'escalated', expect.objectContaining({ reason: 'superadmin_required' }));
    });
  });

  it('sends nothing to the developer bot reached under an alias name, judged on the resolved id', async () => {
    await withStub(async (port, posts) => {
      const { deps, updateStatus } = depsOn(port);
      deps.resolveAgentIdByName = vi.fn(async (name: string) => (name === 'helper' ? DEV_BOT : undefined));
      const workflow = { ticketType: 'platform-tweak', name: 'Platform tweak', pipeline: 'manifest-worker', workerBot: 'helper' };
      await dispatchManifestWorkerTicket(ticketOf('platform-tweak', PERSON) as never, workflow as never, deps as never);
      expect(posts).toEqual([]);
      expect(updateStatus).toHaveBeenCalledWith('tix-platform-tweak', 'escalated', expect.objectContaining({ reason: 'superadmin_required' }));
    });
  });

  it("still dispatches the legitimate 'oshal-dev' lane for a super-admin owner", async () => {
    await withStub(async (port, posts) => {
      const { deps, updateStatus } = depsOn(port);
      await dispatchManifestWorkerTicket(ticketOf('oshal-dev', SUPERADMIN) as never, OSHAL_DEV_LANE as never, deps as never);
      expect(posts.map((p) => p.agentId)).toEqual([DEV_BOT]);
      expect(updateStatus).not.toHaveBeenCalledWith('tix-oshal-dev', 'escalated', expect.anything());
    });
  });
});

/** A manifest that declares the developer bot's id under another name: loaded, it would rename the bot's agents row. */
const ALIAS_BOTS = [{ agentId: DEV_BOT, name: 'helper', role: 'helper', persona: 'persona/helper.md' }];

describe('the alias takeover: a manifest declaring the developer bot under another name', () => {
  it('privilegedManifestRefusal names it, by id or by name, for any app but the lane owner', () => {
    expect(privilegedManifestRefusal({ name: 'rename-fixture', bots: ALIAS_BOTS })).toMatch(/declares the privileged worker/);
    expect(privilegedManifestRefusal({ name: 'rename-fixture', bots: [{ agentId: 'a0000000-0000-0000-0000-000000000002', name: 'OSHAL-Developer' }] })).toMatch(/declares the privileged worker/);
    expect(privilegedManifestRefusal({ name: 'oshal-dev', bots: [{ agentId: DEV_BOT, name: 'oshal-developer' }], ticketType: 'oshal-dev', workflow: OSHAL_DEV_LANE })).toBeNull();
    expect(privilegedManifestRefusal({ name: 'tweaks', bots: [{ agentId: 'a0000000-0000-0000-0000-000000000099', name: 'general-bot' }], workflow: { workerBot: 'general-bot' } })).toBeNull();
  });

  it('is refused at publish', () => {
    expect(() => compileWorkflowSpec({ name: 'rename-fixture', mode: 'single-shot', workerBot: 'helper', bots: ALIAS_BOTS } as never, 'person')).toThrow(/declares the privileged worker/);
  });

  it('is refused when the manifest is read from disk, before any loader path writes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privileged-lane-'));
    try {
      const file = path.join(dir, 'manifest.yaml');
      fs.writeFileSync(file, ['name: rename-fixture', 'displayName: Rename fixture', 'description: alias takeover', 'version: 0.0.1',
        'bots:', `  - agentId: ${DEV_BOT}`, '    name: helper', '    role: helper', '    persona: persona/helper.md', 'ticketType: rename-fixture',
        'workflow:', '  name: Rename', '  pipeline: graph', '  workerBot: helper', ''].join('\n'));
      expect(() => readManifest(file)).toThrow(/declares the privileged worker/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("is refused under the lane owner's reserved name too: at publish, and at read from anywhere but the kernel's swarm-apps directory", () => {
    expect(() => compileWorkflowSpec({ name: 'oshal-dev', mode: 'single-shot', ticketType: 'devalias', workerBot: 'helper', bots: ALIAS_BOTS } as never, 'public')).toThrow(/reserved/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privileged-lane-'));
    try {
      const file = path.join(dir, 'manifest.yaml');
      fs.writeFileSync(file, ['name: oshal-dev', 'displayName: Not the lane', 'description: borrowed name', 'version: 0.0.1',
        'bots:', `  - agentId: ${DEV_BOT}`, '    name: helper', '    role: helper', '    persona: persona/helper.md', 'ticketType: devalias',
        'workflow:', '  name: Alias', '  workerBot: helper', ''].join('\n'));
      expect(() => readManifest(file)).toThrow(/reserved for the privileged lane/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    // The kernel's own manifest still reads.
    expect(readManifest(path.resolve(process.cwd(), 'swarm-apps/oshal-dev.yaml')).name).toBe('oshal-dev');
  });

  it('is refused at the bot upsert, the last line, before any row changes', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const manifest = { name: 'rename-fixture', displayName: 'Rename fixture', description: 'x', version: '0.0.1', bots: ALIAS_BOTS } as never;
    await expect(upsertManifestBots({ query } as unknown as Pool, manifest, '/tmp/rename-fixture/manifest.yaml')).rejects.toThrow(/declares the privileged worker/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('the graph engine judges the resolved id before every dispatch', () => {
  const execute = vi.fn(async (_agentId: string, ..._rest: unknown[]) => ({ success: true, response: 'reply' }));
  const adapter = () => new EngineServicesAdapter({
    resolveAgentIdByName: async (name: string) => (name === 'helper' ? DEV_BOT : name === 'general-bot' ? 'a0000000-0000-0000-0000-000000000099' : undefined),
    botNodeClient: { execute, isDelegationEnforced: () => true } as never,
  } as never);
  const context = (ticketType: string, ownerSub: string) => ({
    externalId: `tix-${ticketType}`, title: 'Change the platform', body: 'self-edit', depth: 0, raw: { ticketId: `tix-${ticketType}`, ticketType, ownerSub, metadata: {} },
  } as never);
  beforeEach(() => execute.mockClear());

  it('runExecution refuses a binding that resolves to the developer bot for a non-privileged ticket, and sends nothing', async () => {
    const result = await adapter().runExecution(context('rename-fixture', SUPERADMIN), { agentBinding: 'helper' } as never);
    expect(result).toMatchObject({ strategy: 'refused', agentId: DEV_BOT, outcome: { dispatched: false, reason: 'superadmin_required' } });
    expect(execute).not.toHaveBeenCalled();
    // The developer bot's own lane, for its super-admin owner, still runs.
    await adapter().runExecution(context('oshal-dev', SUPERADMIN), { agentBinding: 'helper' } as never);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toBe(DEV_BOT);
  });

  it('decisions, cluster steps and plan steps refuse it too, before sending', async () => {
    const engine = adapter();
    await expect(engine.decideBranch(context('rename-fixture', PERSON), { agentBinding: 'helper', outcomes: ['yes', 'no'] } as never)).rejects.toThrow(/superadmin_required/);
    // A plan step reports a refused dispatch instead of throwing, as it reports every other dispatch failure.
    await expect(engine.dispatchAgentPrompt(context('rename-fixture', PERSON), { agentId: DEV_BOT, prompt: 'do it' } as never)).resolves.toMatchObject({ dispatched: false });
    expect(execute).not.toHaveBeenCalled();
    await engine.decideBranch(context('rename-fixture', PERSON), { agentBinding: 'general-bot', outcomes: ['yes', 'no'] } as never).catch(() => undefined);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('the real poll cycle', () => {
  const build = () => {
    const tickets = new TicketService(new InMemoryTicketStore());
    const processTickets = vi.fn(async () => ({ processedCount: 1, processed: [{ selectedAgentId: 'a0000000-0000-0000-0000-000000000002' }] }));
    const processing = { async getRuntimeReadiness() { return { ready: true }; }, processTickets } as never;
    const queueManager = new QueueManagerService(tickets, processing) as unknown as { pollCycle(): Promise<void> };
    return { tickets, queueManager, processTickets };
  };
  const approved = (tickets: TicketService, ticketType: string, ownerSub: string, metadata: Record<string, unknown> = {}) =>
    tickets.createTicket(CreateInternalTicketSchema.parse({ title: 'Change the platform', description: 'self-edit', ticketType, status: 'approved', ownerSub, metadata }));

  it("escalates a non-super-admin's privileged ticket before any branch runs, terminally", async () => {
    // A graph lane for the privileged type, as a registration from before this fix would have left it.
    (registry as unknown as { appWorkflows: Map<string, unknown> }).appWorkflows.set('oshal-dev', {
      appName: 'devtweak', workflow: { ...OSHAL_DEV_LANE, pipeline: 'graph', processDefinition: graphBinding('oshal-developer') },
    });
    registered.push('devtweak');
    const { tickets, queueManager } = build();
    const ticket = await approved(tickets, 'oshal-dev', PERSON);
    await queueManager.pollCycle();
    await queueManager.pollCycle();
    const after = await tickets.getTicket(ticket.ticketId);
    expect(after?.status).toBe('escalated');
    expect(JSON.stringify(after)).toContain('superadmin_required');
  });

  it("leaves a build ticket's PM assignment to the lane, which reroutes it, instead of escalating", async () => {
    const { tickets, queueManager, processTickets } = build();
    const ticket = await approved(tickets, 'build', PERSON, { recommendedPath: 'direct-execution', pmAssignedAgentId: DEV_BOT });
    await queueManager.pollCycle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await tickets.getTicket(ticket.ticketId))?.status).not.toBe('escalated');
    expect(processTickets).toHaveBeenCalled();
  });
});
