/**
 * Graph domain ingestion guard (ADR-045 "Adoption") — the regression spec for the three
 * promised ingestions finally being wired: ticket lifecycle → TENANT graph, capture
 * opportunities → TENANT graph, jobs → PERSON graph.
 *
 * Pins the four contract behaviors with a FAKE connector (never a live engine):
 *   (a) ticket lifecycle events (created / assigned / status-changed / completed) upsert the
 *       right nodes+edges into the tenant graph THROUGH THE REAL SEAM (TicketService → shared
 *       ticketEvents bus → subscription) — sanitized: clipped title, never the description;
 *   (b) a capture opportunity upserts opportunity ↔ agency ↔ NAICS (+ the tracking ticket edge);
 *   (c) engine absent (connector factory → null): every ingest is a clean no-op and the host
 *       flow (ticket creation) is unaffected;
 *   (d) a THROWING connector (factory throw / handle rejection / upsert rejection): logged at
 *       ERROR, never rethrown, host flow unaffected.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guard-per-fix spec for the ADR-045 domain ingestions (ticket-events / capture / jobs) with a fake connector: correct upserts, tenant-vs-person tier routing, engine-absent no-op, and fail-open on a throwing connector.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));
vi.mock('@/shared/logger', () => ({
  createChildLogger: () => logSpies,
  logger: logSpies,
  LOG_REDACT_OPTIONS: { paths: [], censor: '[redacted]' },
}));

import {
  GraphIngestionService,
  startTicketGraphIngestion,
  SWARM_GRAPH_TENANT,
  type GraphEdge,
  type GraphHandle,
  type GraphIngestionConnector,
  type GraphNode,
} from '@/features/graph';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import type { CreateInternalTicketInput } from '@/entities/ticket';

/** In-memory GraphHandle that records upserts (merge semantics mirror the Arango UPDATE). */
class FakeGraphHandle implements GraphHandle {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges: GraphEdge[] = [];

  async upsertNodes(nodes: GraphNode[]): Promise<number> {
    for (const n of nodes) {
      const prev = this.nodes.get(n.id);
      this.nodes.set(n.id, prev
        ? { ...prev, ...n, props: { ...(prev.props ?? {}), ...(n.props ?? {}) } }
        : n);
    }
    return nodes.length;
  }

  async upsertEdges(edges: GraphEdge[]): Promise<number> {
    this.edges.push(...edges);
    return edges.length;
  }

  async neighbors(): Promise<GraphNode[]> { return []; }
  async shortestPath(): Promise<GraphNode[]> { return []; }
  async rawQuery(): Promise<unknown[]> { return []; }
}

/** Fake connector: isolated handles per tenant / per person, like the real one. */
class FakeConnector implements GraphIngestionConnector {
  readonly tenants = new Map<string, FakeGraphHandle>();
  readonly persons = new Map<string, FakeGraphHandle>();

  async getTenantGraph(tenant: string): Promise<GraphHandle> {
    let h = this.tenants.get(tenant);
    if (!h) { h = new FakeGraphHandle(); this.tenants.set(tenant, h); }
    return h;
  }

  async getPersonGraph(sub: string): Promise<GraphHandle> {
    let h = this.persons.get(sub);
    if (!h) { h = new FakeGraphHandle(); this.persons.set(sub, h); }
    return h;
  }
}

/** Two macrotask turns — enough for the fire-and-forget promise chains to settle. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function findEdge(g: FakeGraphHandle, from: string, to: string, type: string): GraphEdge | undefined {
  return g.edges.find((e) => e.from === from && e.to === to && e.type === type);
}

function ticketInput(overrides: Partial<CreateInternalTicketInput> & { title: string }): CreateInternalTicketInput {
  return {
    title: overrides.title,
    ticketType: overrides.ticketType ?? 'build',
    description: overrides.description ?? '',
    status: overrides.status ?? 'backlog',
    priority: 'none',
    labels: [],
    workspaceId: null,
    assignedAgentId: overrides.assignedAgentId ?? null,
    parentTicketId: overrides.parentTicketId ?? null,
    externalProvider: null,
    externalId: null,
    externalUrl: null,
    metadata: {},
  };
}

describe('graph domain ingestion (ADR-045)', () => {
  let stop: (() => void) | null = null;

  afterEach(() => {
    if (stop) { stop(); stop = null; }
    vi.clearAllMocks();
  });

  describe('(a) ticket lifecycle → tenant graph, through the real seam', () => {
    it('creation upserts sanitized ticket/agent nodes + assigned_to/parent_of edges', async () => {
      const fake = new FakeConnector();
      stop = startTicketGraphIngestion(new GraphIngestionService(() => fake));
      const tickets = new TicketService(new InMemoryTicketStore());

      const parent = await tickets.createTicket(ticketInput({ title: 'Parent build' }));
      const child = await tickets.createTicket(ticketInput({
        title: 'c'.repeat(500),
        description: 'SECRET-FULL-DESCRIPTION must never reach the graph',
        ticketType: 'incident-remediation',
        assignedAgentId: 'agent-123',
        parentTicketId: parent.ticketId,
      }));
      await flush();

      // Tenant tier, and exactly the shared default tenant.
      expect(SWARM_GRAPH_TENANT).toBe('default');
      expect([...fake.tenants.keys()]).toEqual(['default']);
      expect(fake.persons.size).toBe(0);

      const g = fake.tenants.get('default') as FakeGraphHandle;
      const node = g.nodes.get(`ticket:${child.ticketId}`) as GraphNode;
      expect(node.labels).toEqual(['ticket']);
      expect(node.props?.ticketType).toBe('incident-remediation');
      expect(node.props?.status).toBe(child.status);
      // Sanitized: clipped title, and the description NEVER rides into the graph.
      expect(String(node.props?.title).length).toBeLessThanOrEqual(120);
      expect(JSON.stringify([...g.nodes.values()])).not.toContain('SECRET-FULL-DESCRIPTION');

      expect(g.nodes.get('agent:agent-123')?.labels).toEqual(['agent']);
      expect(findEdge(g, `ticket:${child.ticketId}`, 'agent:agent-123', 'assigned_to')).toBeTruthy();
      expect(findEdge(g, `ticket:${parent.ticketId}`, `ticket:${child.ticketId}`, 'parent_of')).toBeTruthy();
    });

    it('status transitions refresh the node; agent completion records produced_by (system does not)', async () => {
      const fake = new FakeConnector();
      stop = startTicketGraphIngestion(new GraphIngestionService(() => fake));
      const tickets = new TicketService(new InMemoryTicketStore());

      const byAgent = await tickets.createTicket(ticketInput({ title: 'agent-completed' }));
      const bySystem = await tickets.createTicket(ticketInput({ title: 'system-completed' }));
      await tickets.updateStatus(byAgent.ticketId, 'approved');
      await tickets.updateStatus(bySystem.ticketId, 'approved');
      await flush();

      const g = fake.tenants.get('default') as FakeGraphHandle;
      expect(g.nodes.get(`ticket:${byAgent.ticketId}`)?.props?.status).toBe('approved');

      await tickets.updateStatusAs(byAgent.ticketId, 'complete', 'agent-999', 'Worker Bot');
      await tickets.updateStatus(bySystem.ticketId, 'complete'); // store default actor: 'system'
      await flush();

      expect(g.nodes.get(`ticket:${byAgent.ticketId}`)?.props?.status).toBe('complete');
      expect(findEdge(g, `ticket:${byAgent.ticketId}`, 'agent:agent-999', 'produced_by')).toBeTruthy();
      expect(g.edges.some((e) => e.type === 'produced_by' && e.from === `ticket:${bySystem.ticketId}`)).toBe(false);
    });

    it('assignAgent records an assigned_to edge carrying the role', async () => {
      const fake = new FakeConnector();
      stop = startTicketGraphIngestion(new GraphIngestionService(() => fake));
      const tickets = new TicketService(new InMemoryTicketStore());

      const t = await tickets.createTicket(ticketInput({ title: 'assignable' }));
      await tickets.assignAgent(t.ticketId, 'agent-777', 'reviewer');
      await flush();

      const g = fake.tenants.get('default') as FakeGraphHandle;
      const edge = findEdge(g, `ticket:${t.ticketId}`, 'agent:agent-777', 'assigned_to');
      expect(edge?.props?.role).toBe('reviewer');
    });

    it('start is idempotent and stop() unsubscribes cleanly', async () => {
      const fake = new FakeConnector();
      const service = new GraphIngestionService(() => fake);
      stop = startTicketGraphIngestion(service);
      expect(startTicketGraphIngestion(service)).toBe(stop); // second start: same handle, no double-subscribe

      const tickets = new TicketService(new InMemoryTicketStore());
      await tickets.createTicket(ticketInput({ title: 'once' }));
      await flush();
      const g = fake.tenants.get('default') as FakeGraphHandle;
      const nodesAfterFirst = g.nodes.size;
      expect(nodesAfterFirst).toBeGreaterThan(0);

      stop();
      stop = null;
      await tickets.createTicket(ticketInput({ title: 'after stop — not ingested' }));
      await flush();
      expect(g.nodes.size).toBe(nodesAfterFirst);
    });
  });

  describe('(b) capture opportunity → tenant graph', () => {
    it('upserts opportunity ↔ agency ↔ NAICS and links the tracking ticket', async () => {
      const fake = new FakeConnector();
      const service = new GraphIngestionService(() => fake);

      await service.ingestCaptureOpportunity({
        noticeId: 'SAM-0001',
        title: 'Radar sustainment support',
        agency: 'Dept of the Air Force',
        naics: '541512',
        setAside: 'SB',
        due: '2026-08-01',
        url: 'https://sam.gov/opp/SAM-0001',
        fitScore: 87,
        ticketId: '11111111-2222-3333-4444-555555555555',
        tenant: 'default',
      });

      const g = fake.tenants.get('default') as FakeGraphHandle;
      const opp = g.nodes.get('opportunity:SAM-0001') as GraphNode;
      expect(opp.labels).toEqual(['opportunity']);
      expect(opp.props).toMatchObject({ title: 'Radar sustainment support', naics: '541512', setAside: 'SB', fitScore: 87 });
      expect(g.nodes.get('agency:Dept of the Air Force')?.labels).toEqual(['agency']);
      expect(g.nodes.get('naics:541512')?.labels).toEqual(['naics']);
      expect(findEdge(g, 'opportunity:SAM-0001', 'agency:Dept of the Air Force', 'issued_by')).toBeTruthy();
      expect(findEdge(g, 'opportunity:SAM-0001', 'naics:541512', 'classified_as')).toBeTruthy();
      expect(findEdge(g, 'ticket:11111111-2222-3333-4444-555555555555', 'opportunity:SAM-0001', 'tracks')).toBeTruthy();
    });

    it('omits NAICS/ticket artifacts when absent', async () => {
      const fake = new FakeConnector();
      const service = new GraphIngestionService(() => fake);
      await service.ingestCaptureOpportunity({ noticeId: 'SAM-0002', title: 'Janitorial', agency: 'GSA' });
      const g = fake.tenants.get(SWARM_GRAPH_TENANT) as FakeGraphHandle;
      expect(g.nodes.has('opportunity:SAM-0002')).toBe(true);
      expect([...g.nodes.keys()].some((k) => k.startsWith('naics:'))).toBe(false);
      expect(g.edges.filter((e) => e.type !== 'issued_by')).toEqual([]);
    });
  });

  describe('jobs → PERSON graph (store-package entry point)', () => {
    it('upserts jobs ↔ companies ↔ recruiters into the owning sub\'s graph, never the tenant tier', async () => {
      const fake = new FakeConnector();
      const service = new GraphIngestionService(() => fake);

      await service.ingestJobsForPerson('auth0|the operator', [
        { id: 42, title: 'Platform Engineer', company: 'Acme Corp', recruiter: 'Jane Doe', location: 'Remote', url: 'https://jobs.example/42' },
        { id: 43, title: 'SRE', company: 'Acme Corp' },
      ]);

      expect(fake.tenants.size).toBe(0); // person tier only
      const g = fake.persons.get('auth0|the operator') as FakeGraphHandle;
      expect(g.nodes.get('job:42')?.props).toMatchObject({ title: 'Platform Engineer', location: 'Remote' });
      expect(g.nodes.get('company:Acme Corp')?.labels).toEqual(['company']);
      expect(g.nodes.get('recruiter:Jane Doe')?.labels).toEqual(['recruiter']);
      expect(findEdge(g, 'job:42', 'company:Acme Corp', 'posted_by')).toBeTruthy();
      expect(findEdge(g, 'job:43', 'company:Acme Corp', 'posted_by')).toBeTruthy();
      expect(findEdge(g, 'recruiter:Jane Doe', 'company:Acme Corp', 'recruits_for')).toBeTruthy();
      expect(findEdge(g, 'job:42', 'recruiter:Jane Doe', 'handled_by')).toBeTruthy();
      expect(g.edges.some((e) => e.from === 'job:43' && e.type === 'handled_by')).toBe(false);
    });

    it('empty inputs never touch the connector', async () => {
      const factory = vi.fn(() => new FakeConnector());
      const service = new GraphIngestionService(factory);
      await service.ingestJobsForPerson('', [{ id: 1, title: 't', company: 'c' }]);
      await service.ingestJobsForPerson('auth0|the operator', []);
      expect(factory).not.toHaveBeenCalled();
    });
  });

  describe('(c) engine absent — connector factory returns null', () => {
    it('every ingest method is a clean no-op (resolves, never throws)', async () => {
      const service = new GraphIngestionService(() => null);
      await expect(service.ingestTicketCreated({
        ticketId: 't1', title: 'x', ticketType: 'build', status: 'backlog', assignedAgentId: 'a', parentTicketId: null, timestamp: 'now',
      })).resolves.toBeUndefined();
      await expect(service.ingestTicketStatusChanged({
        ticketId: 't1', fromStatus: 'backlog', toStatus: 'complete', changedBy: 'agent-1', changedByLabel: 'A', timestamp: 'now',
      })).resolves.toBeUndefined();
      await expect(service.ingestTicketAgentAssigned({ ticketId: 't1', agentId: 'a', role: 'executor', timestamp: 'now' })).resolves.toBeUndefined();
      await expect(service.ingestCaptureOpportunity({ noticeId: 'n', title: 't', agency: 'a' })).resolves.toBeUndefined();
      await expect(service.ingestJobsForPerson('sub', [{ id: 1, title: 't', company: 'c' }])).resolves.toBeUndefined();
      expect(logSpies.error).not.toHaveBeenCalled();
    });

    it('the host ticket flow is unaffected with the subscription live and no engine', async () => {
      stop = startTicketGraphIngestion(new GraphIngestionService(() => null));
      const tickets = new TicketService(new InMemoryTicketStore());
      const t = await tickets.createTicket(ticketInput({ title: 'no engine, still created' }));
      await tickets.updateStatus(t.ticketId, 'approved');
      await flush();
      expect((await tickets.getTicket(t.ticketId))?.status).toBe('approved');
    });
  });

  describe('(d) throwing connector — logged, host flow unaffected', () => {
    it('a throwing factory degrades to disabled: logged once, every call still resolves', async () => {
      const service = new GraphIngestionService(() => { throw new Error('factory boom'); });
      await expect(service.ingestCaptureOpportunity({ noticeId: 'n', title: 't', agency: 'a' })).resolves.toBeUndefined();
      await expect(service.ingestJobsForPerson('sub', [{ id: 1, title: 't', company: 'c' }])).resolves.toBeUndefined();
      expect(logSpies.error).toHaveBeenCalled();
    });

    it('a rejecting handle resolution is caught and logged, never rethrown', async () => {
      const connector: GraphIngestionConnector = {
        getTenantGraph: async () => { throw new Error('tenant graph down'); },
        getPersonGraph: async () => { throw new Error('person graph down'); },
      };
      const service = new GraphIngestionService(() => connector);
      await expect(service.ingestTicketCreated({
        ticketId: 't1', title: 'x', ticketType: 'build', status: 'backlog', assignedAgentId: null, parentTicketId: null, timestamp: 'now',
      })).resolves.toBeUndefined();
      await expect(service.ingestJobsForPerson('sub', [{ id: 1, title: 't', company: 'c' }])).resolves.toBeUndefined();
      expect(logSpies.error).toHaveBeenCalledTimes(2);
    });

    it('a rejecting upsert is caught and logged; the host ticket flow completes', async () => {
      const broken = new FakeConnector();
      const handle = new FakeGraphHandle();
      handle.upsertNodes = async () => { throw new Error('write refused'); };
      broken.getTenantGraph = async () => handle;
      stop = startTicketGraphIngestion(new GraphIngestionService(() => broken));

      const tickets = new TicketService(new InMemoryTicketStore());
      const t = await tickets.createTicket(ticketInput({ title: 'engine writes failing' }));
      await flush();

      expect(t.ticketId).toBeTruthy();
      expect((await tickets.getTicket(t.ticketId))?.title).toBe('engine writes failing');
      expect(logSpies.error).toHaveBeenCalled();
      const [firstCallArgs] = logSpies.error.mock.calls;
      expect(String(firstCallArgs?.[1] ?? '')).toContain('host flow unaffected');
    });
  });
});
