/**
 * Graph domain ingestion — ADR-045 "Adoption": a domain carve-out is ingestion + NL queries over
 * the SAME connector, never a new service.
 *
 * This is the ingestion half. Three domains flow in through here: the swarm operational graph
 * (ticket ↔ agent lifecycle events, TENANT tier), the federal-capture domain (opportunities ↔
 * agencies ↔ NAICS, TENANT tier), and the jobs domain (jobs ↔ companies ↔ recruiters, PERSON tier
 * keyed by the owning sub — the caller is the carved career-hunter store package, which imports
 * this via the preserved `@/features/graph` alias).
 *
 * Every ingest method is fail-open by contract: it NEVER throws, NEVER blocks the host flow
 * beyond its own awaited writes (callers fire-and-forget with `void`), and is a clean no-op when
 * the graph engine is absent (createGraphConnector() → null, i.e. ARANGO_URL unset). Payloads are
 * deliberately small and sanitized — ids / titles / status only, never ticket descriptions.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-045 domain ingestions: GraphIngestionService (ticket lifecycle → tenant graph; capture opportunities → tenant graph; jobs → person graph), lazy singleton, and startTicketGraphIngestion() subscribing the shared ticketEvents bus. Engine-gated no-op when the connector is null; every method catch-logs and never rethrows.
 *
 * @module graph-ingestion
 */
import { createChildLogger } from '@/shared/logger';
import {
  ticketEvents,
  type TicketAgentAssignedEvent,
  type TicketCreatedEvent,
  type TicketStatusChangedEvent,
} from '@/shared/ticket-events';
import type { GraphEdge, GraphHandle, GraphNode } from './graph-types';
import { createGraphConnector } from './graph-connector';

const logger = createChildLogger({ module: 'graph-ingestion' });

/** The shared tenant the swarm operational + capture graphs live in (single-tenant default —
 *  matches the gov-contracting store tenant). */
export const SWARM_GRAPH_TENANT = 'default';

/** Longest title stored on any graph node — ingestion carries identifiers, not documents. */
const MAX_TITLE = 120;

/** The slice of GraphConnector ingestion needs — structurally satisfied by the real one;
 *  tests inject a fake. */
export interface GraphIngestionConnector {
  getPersonGraph(sub: string): Promise<GraphHandle>;
  getTenantGraph(tenant: string): Promise<GraphHandle>;
}

/** A promoted capture opportunity (the gov-contracting cron's lead row, sanitized). */
export interface CaptureOpportunityGraphEvent {
  noticeId: string;
  title: string;
  agency: string;
  naics?: string | null;
  setAside?: string | null;
  due?: string | null;
  url?: string | null;
  fitScore?: number | null;
  /** The federal-capture ticket queued for this notice, when one was created. */
  ticketId?: string | null;
  /** Tenant the capture store belongs to (defaults to SWARM_GRAPH_TENANT). */
  tenant?: string | null;
}

/** One job record for the person-tier jobs graph (career-hunter store package calls this). */
export interface JobGraphRecord {
  id: string | number;
  title: string;
  company: string;
  recruiter?: string | null;
  location?: string | null;
  url?: string | null;
}

/** Truncate free text to a node-safe size (identifier-scale, never document-scale). */
function clip(text: string | null | undefined, max = MAX_TITLE): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** True when a status-change actor is a real agent id (not the 'user'/'system' sentinels). */
function isAgentActor(changedBy: string | null | undefined): boolean {
  return Boolean(changedBy) && changedBy !== 'user' && changedBy !== 'system';
}

/**
 * @description Engine-gated, fail-open domain ingestion over the ADR-045 graph connector.
 * One instance resolves the connector ONCE (lazily) and reuses it; when the engine is absent
 * (factory → null) every ingest method is a clean no-op. No method ever throws — failures are
 * logged at ERROR and swallowed so the host flow (ticket creation, cron, store writes) is
 * never blocked or failed by graph availability.
 */
export class GraphIngestionService {
  private connector: GraphIngestionConnector | null = null;
  private resolved = false;

  /**
   * @param connectorFactory - source of the graph connector; defaults to the env factory
   *   (createGraphConnector — null when ARANGO_URL is unset). Tests inject a fake.
   */
  constructor(private readonly connectorFactory: () => GraphIngestionConnector | null = createGraphConnector) {}

  /**
   * @description Ingest a newly created ticket into the shared tenant graph: the ticket node,
   * its assigned agent (assigned_to) and its parent link (parent_of). Sanitized — id, clipped
   * title, type, status only; the description never leaves the ticket store.
   * @param evt - the sanitized creation event from the shared ticket bus
   * @returns resolves when the write completes or was skipped; never rejects
   */
  async ingestTicketCreated(evt: TicketCreatedEvent): Promise<void> {
    try {
      const g = await this.tenantGraph(SWARM_GRAPH_TENANT);
      if (!g) return;
      const ticketNodeId = `ticket:${evt.ticketId}`;
      const nodes: GraphNode[] = [{
        id: ticketNodeId,
        labels: ['ticket'],
        props: { title: clip(evt.title), ticketType: evt.ticketType, status: evt.status },
      }];
      const edges: GraphEdge[] = [];
      if (evt.assignedAgentId) {
        nodes.push({ id: `agent:${evt.assignedAgentId}`, labels: ['agent'], props: {} });
        edges.push({ from: ticketNodeId, to: `agent:${evt.assignedAgentId}`, type: 'assigned_to' });
      }
      if (evt.parentTicketId) {
        edges.push({ from: `ticket:${evt.parentTicketId}`, to: ticketNodeId, type: 'parent_of' });
      }
      await g.upsertNodes(nodes);
      if (edges.length) await g.upsertEdges(edges);
    } catch (err) {
      logger.error({ err, stack: (err as Error)?.stack, ticketId: evt.ticketId }, 'ticket-created graph ingestion failed (host flow unaffected)');
    }
  }

  /**
   * @description Ingest a ticket status transition: refresh the ticket node's status, and on
   * completion by a real agent record the produced_by edge (ticket → completing agent).
   * @param evt - the status-changed event the ticket stores already emit
   * @returns resolves when the write completes or was skipped; never rejects
   */
  async ingestTicketStatusChanged(evt: TicketStatusChangedEvent): Promise<void> {
    try {
      const g = await this.tenantGraph(SWARM_GRAPH_TENANT);
      if (!g) return;
      const ticketNodeId = `ticket:${evt.ticketId}`;
      await g.upsertNodes([{ id: ticketNodeId, labels: ['ticket'], props: { status: evt.toStatus } }]);
      if (evt.toStatus === 'complete' && isAgentActor(evt.changedBy)) {
        await g.upsertNodes([{ id: `agent:${evt.changedBy}`, labels: ['agent'], props: { name: clip(evt.changedByLabel) } }]);
        await g.upsertEdges([{ from: ticketNodeId, to: `agent:${evt.changedBy}`, type: 'produced_by' }]);
      }
    } catch (err) {
      logger.error({ err, stack: (err as Error)?.stack, ticketId: evt.ticketId }, 'ticket-status graph ingestion failed (host flow unaffected)');
    }
  }

  /**
   * @description Ingest an agent assignment (TicketService.assignAgent) as an assigned_to edge.
   * @param evt - the agent-assigned event from the shared ticket bus
   * @returns resolves when the write completes or was skipped; never rejects
   */
  async ingestTicketAgentAssigned(evt: TicketAgentAssignedEvent): Promise<void> {
    try {
      const g = await this.tenantGraph(SWARM_GRAPH_TENANT);
      if (!g) return;
      await g.upsertNodes([{ id: `agent:${evt.agentId}`, labels: ['agent'], props: {} }]);
      await g.upsertEdges([{
        from: `ticket:${evt.ticketId}`,
        to: `agent:${evt.agentId}`,
        type: 'assigned_to',
        props: { role: evt.role },
      }]);
    } catch (err) {
      logger.error({ err, stack: (err as Error)?.stack, ticketId: evt.ticketId }, 'agent-assigned graph ingestion failed (host flow unaffected)');
    }
  }

  /**
   * @description Ingest a promoted capture opportunity into the tenant graph: opportunity ↔
   * agency (issued_by), opportunity ↔ NAICS (classified_as), and — when the cron queued a
   * federal-capture ticket for it — ticket → opportunity (tracks), joining the capture domain
   * to the swarm operational graph in the same tenant database.
   * @param evt - the sanitized lead row from the gov-contracting cron seam
   * @returns resolves when the write completes or was skipped; never rejects
   */
  async ingestCaptureOpportunity(evt: CaptureOpportunityGraphEvent): Promise<void> {
    try {
      const g = await this.tenantGraph(evt.tenant || SWARM_GRAPH_TENANT);
      if (!g) return;
      const oppId = `opportunity:${evt.noticeId}`;
      const agencyId = `agency:${clip(evt.agency)}`;
      const nodes: GraphNode[] = [
        {
          id: oppId,
          labels: ['opportunity'],
          props: {
            title: clip(evt.title),
            naics: evt.naics ?? null,
            setAside: evt.setAside ?? null,
            due: evt.due ?? null,
            url: evt.url ?? null,
            fitScore: evt.fitScore ?? null,
          },
        },
        { id: agencyId, labels: ['agency'], props: { name: clip(evt.agency) } },
      ];
      const edges: GraphEdge[] = [{ from: oppId, to: agencyId, type: 'issued_by' }];
      if (evt.naics) {
        nodes.push({ id: `naics:${evt.naics}`, labels: ['naics'], props: { name: clip(evt.naics) } });
        edges.push({ from: oppId, to: `naics:${evt.naics}`, type: 'classified_as' });
      }
      if (evt.ticketId) edges.push({ from: `ticket:${evt.ticketId}`, to: oppId, type: 'tracks' });
      await g.upsertNodes(nodes);
      await g.upsertEdges(edges);
    } catch (err) {
      logger.error({ err, stack: (err as Error)?.stack, noticeId: evt.noticeId }, 'capture graph ingestion failed (host flow unaffected)');
    }
  }

  /**
   * @description Ingest job records into the OWNING PERSON's graph (jobs ↔ companies ↔
   * recruiters). The career-hunter domain is carved to the store package — that package is the
   * caller (via the preserved `@/features/graph` alias); the kernel deliberately has no jobs
   * write seam left to hook.
   * @param sub - the owning user's sub (the person-graph isolation key)
   * @param jobs - sanitized job records (ids/titles/names only)
   * @returns resolves when the write completes or was skipped; never rejects
   */
  async ingestJobsForPerson(sub: string, jobs: JobGraphRecord[]): Promise<void> {
    try {
      if (!sub || !jobs.length) return;
      const connector = this.resolveConnector();
      if (!connector) return;
      const g = await connector.getPersonGraph(sub);
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      for (const job of jobs) {
        const jobId = `job:${job.id}`;
        const companyId = `company:${clip(job.company)}`;
        nodes.push({ id: jobId, labels: ['job'], props: { title: clip(job.title), location: job.location ?? null, url: job.url ?? null } });
        nodes.push({ id: companyId, labels: ['company'], props: { name: clip(job.company) } });
        edges.push({ from: jobId, to: companyId, type: 'posted_by' });
        if (job.recruiter) {
          const recruiterId = `recruiter:${clip(job.recruiter)}`;
          nodes.push({ id: recruiterId, labels: ['recruiter'], props: { name: clip(job.recruiter) } });
          edges.push({ from: recruiterId, to: companyId, type: 'recruits_for' });
          edges.push({ from: jobId, to: recruiterId, type: 'handled_by' });
        }
      }
      await g.upsertNodes(nodes);
      await g.upsertEdges(edges);
    } catch (err) {
      logger.error({ err, stack: (err as Error)?.stack, jobs: jobs.length }, 'jobs graph ingestion failed (host flow unaffected)');
    }
  }

  /** Resolve the tenant graph, or null when the engine is absent. Errors propagate to the
   *  per-method catch (which logs and swallows). */
  private async tenantGraph(tenant: string): Promise<GraphHandle | null> {
    const connector = this.resolveConnector();
    if (!connector) return null;
    return connector.getTenantGraph(tenant);
  }

  /** Resolve the connector exactly once (a throwing factory degrades to disabled, logged). */
  private resolveConnector(): GraphIngestionConnector | null {
    if (!this.resolved) {
      this.resolved = true;
      try {
        this.connector = this.connectorFactory();
      } catch (err) {
        logger.error({ err, stack: (err as Error)?.stack }, 'graph connector factory failed — graph ingestion disabled');
        this.connector = null;
      }
    }
    return this.connector;
  }
}

let singleton: GraphIngestionService | null = null;

/**
 * @description Process-wide GraphIngestionService (one connector resolution per process).
 * Hooks (composition root, the gov-contracting cron, store packages) share this instance.
 * @returns the shared ingestion service
 */
export function getGraphIngestionService(): GraphIngestionService {
  if (!singleton) singleton = new GraphIngestionService();
  return singleton;
}

let activeStop: (() => void) | null = null;

/**
 * @description Subscribe the swarm operational graph to the shared ticketEvents bus (created /
 * status-changed / agent-assigned → tenant-graph upserts). Idempotent — a second call returns
 * the existing stop handle. Handlers fire-and-forget into the ingestion service, so a slow or
 * absent graph engine never back-pressures the ticket lifecycle.
 * @param service - the ingestion service to feed (defaults to the shared singleton)
 * @returns a stop function that unsubscribes (used by tests; production never stops)
 */
export function startTicketGraphIngestion(service: GraphIngestionService = getGraphIngestionService()): () => void {
  if (activeStop) return activeStop;
  const onCreated = (evt: TicketCreatedEvent): void => { void service.ingestTicketCreated(evt); };
  const onStatus = (evt: TicketStatusChangedEvent): void => { void service.ingestTicketStatusChanged(evt); };
  const onAssigned = (evt: TicketAgentAssignedEvent): void => { void service.ingestTicketAgentAssigned(evt); };
  ticketEvents.onTicketCreated(onCreated);
  ticketEvents.onStatusChanged(onStatus);
  ticketEvents.onAgentAssigned(onAssigned);
  logger.info('ticket → graph ingestion subscribed (engine-gated; no-op without ARANGO_URL)');
  activeStop = (): void => {
    ticketEvents.removeListener('ticket-created', onCreated);
    ticketEvents.removeListener('status-changed', onStatus);
    ticketEvents.removeListener('agent-assigned', onAssigned);
    activeStop = null;
  };
  return activeStop;
}
