/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial PlaneSyncService for bidirectional Plane synchronization
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Session 140: Added simple 3-point polling loop (poll todo → in-process → complete). No subtickets.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Ran the Plane sync poll cycle under runWithSystemIdentity — background sync that reads/writes the FORCE-RLS tickets table; SYSTEM keeps it visible once OSHAL_DB_GUC_STRICT denies the identity-less case.
 */

import type { TicketService } from './ticket-service';
import { CreateInternalTicketSchema, type OshalTicketState } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

const logger = createChildLogger({ module: 'PlaneSyncService' });

/**
 * @description Configuration for connecting to a Plane instance.
 */
interface PlaneSyncConfig {
  baseUrl: string;
  apiKey: string;
  workspaceSlug: string;
  projectId: string;
}

/**
 * @description Bidirectional synchronization service between internal tickets and Plane issues.
 * Pulls issues from Plane to create/update internal tickets and pushes internal ticket
 * status changes back to Plane.
 */
/**
 * @description Configurable queue state to poll from Plane. Defaults to 'unstarted' (Plane's "Todo").
 */
const DEFAULT_POLL_STATE = 'unstarted';
const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * @description Bidirectional synchronization service between internal tickets and Plane issues.
 * Pulls Plane issues into internal tickets, runs a 3-point polling loop (todo → in-process →
 * complete), and pushes internal status changes/completions back to Plane via its REST API.
 */
export class PlaneSyncService {
  private config: PlaneSyncConfig | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollState: string = DEFAULT_POLL_STATE;

  constructor(private readonly ticketService: TicketService) {}

  /**
   * @description Configures the Plane connection. Must be called before pull/push operations.
   * @param config - Plane connection configuration
   */
  configure(config: PlaneSyncConfig): void {
    this.config = config;
    logger.info({ baseUrl: config.baseUrl, workspaceSlug: config.workspaceSlug }, 'Plane sync configured');
  }

  /**
   * @description Returns whether the sync service has a valid Plane configuration.
   * @returns True if configured
   */
  isConfigured(): boolean {
    return this.config !== null;
  }

  // ─── 3-Point Polling Loop ─────────────────────────────────────────────

  /**
   * @description Starts the simple 3-point polling loop:
   *   1. Poll Plane for tickets in the configured queue state (default: "unstarted"/Todo)
   *   2. Move each found ticket to "started" (In Process) on Plane and create internally as "approved"
   *   3. On internal completion, push "completed" back to Plane with the ticket payload
   * No subtickets — each Plane issue maps 1:1 to an internal ticket.
   * @param intervalMs - Poll interval in milliseconds (default 60s)
   * @param queueState - Plane state group to poll (default 'unstarted')
   */
  startPolling(intervalMs = DEFAULT_POLL_INTERVAL_MS, queueState = DEFAULT_POLL_STATE): void {
    if (this.pollTimer) {
      logger.warn('Plane sync polling already running');
      return;
    }
    if (!this.config) {
      logger.error('Cannot start polling — PlaneSyncService not configured');
      return;
    }
    this.pollState = queueState;
    logger.info({ intervalMs, queueState }, 'Starting Plane sync polling loop');
    void runWithSystemIdentity(() => this.pollCycle());
    this.pollTimer = setInterval(() => void runWithSystemIdentity(() => this.pollCycle()), intervalMs);
    (this.pollTimer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
  }

  /**
   * @description Stops the polling loop.
   */
  stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    logger.info('Plane sync polling stopped');
  }

  /**
   * @description One poll cycle: fetch Plane issues in the target state,
   * transition each to "started" on Plane, and create an internal approved ticket.
   */
  private async pollCycle(): Promise<void> {
    if (!this.config) return;
    const { baseUrl, apiKey, workspaceSlug, projectId } = this.config;

    try {
      const issues = await this.fetchIssuesByState(baseUrl, apiKey, workspaceSlug, projectId, this.pollState);
      if (issues.length === 0) {
        logger.debug({ queueState: this.pollState }, 'No Plane issues in target state');
        return;
      }

      logger.info({ count: issues.length, queueState: this.pollState }, 'Found Plane issues to process');

      for (const issue of issues) {
        try {
          // Step 1: Check if we already have this ticket internally
          const existing = await this.ticketService.getTicketByExternalId('plane', issue.id);
          if (existing) {
            logger.debug({ issueId: issue.id }, 'Plane issue already imported — skipping');
            continue;
          }

          // Step 2: Move to "started" (In Process) on Plane
          await this.transitionIssueState(baseUrl, apiKey, workspaceSlug, projectId, issue.id, 'started');

          // Step 3: Create internal ticket in backlog — operator must approve before the swarm starts work.
          const parsed = CreateInternalTicketSchema.parse({
            title: issue.name,
            description: issue.description ?? '',
            status: 'backlog',
            priority: mapPlanePriority(issue.priority),
            labels: issue.label_detail?.map((l: { name: string }) => l.name) ?? [],
            externalProvider: 'plane',
            externalId: issue.id,
            externalUrl: `${baseUrl}/${workspaceSlug}/projects/${projectId}/issues/${issue.id}`,
          });
          await this.ticketService.createTicket(parsed);
          logger.info({ issueId: issue.id, title: issue.name }, 'Imported Plane issue → internal approved ticket');
        } catch (err) {
          logger.error({ err, issueId: issue.id }, 'Failed to import Plane issue — will retry next cycle');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Plane poll cycle failed — will retry next interval');
    }
  }

  /**
   * @description Pushes a completion status back to Plane when an internal ticket finishes.
   * This is the "step 3" of the 3-point integration: on completion, push to complete on Plane.
   * @param ticketId - Internal ticket identifier
   * @param payload - Optional completion payload (summary, deliverables, etc.)
   */
  async pushCompletion(ticketId: string, payload?: { summary?: string; deliverables?: string[] }): Promise<void> {
    if (!this.config) return;

    const ticket = await this.ticketService.getTicket(ticketId);
    if (!ticket || !ticket.externalId || ticket.externalProvider !== 'plane') {
      return;
    }

    const { baseUrl, apiKey, workspaceSlug, projectId } = this.config;

    try {
      // Transition to "completed" on Plane
      await this.transitionIssueState(baseUrl, apiKey, workspaceSlug, projectId, ticket.externalId, 'completed');

      // Post completion comment with payload
      const comment = this.formatCompletionComment(ticket.title, payload);
      await this.pushComment(baseUrl, apiKey, workspaceSlug, projectId, ticket.externalId, comment);

      logger.info({ ticketId, externalId: ticket.externalId }, 'Pushed completion to Plane');
    } catch (err) {
      logger.error({ err, ticketId }, 'Failed to push completion to Plane');
    }
  }

  /**
   * @description Fetches Plane issues filtered by state group.
   */
  private async fetchIssuesByState(
    baseUrl: string, apiKey: string, workspaceSlug: string, projectId: string, stateGroup: string,
  ): Promise<PlaneIssue[]> {
    const url = `${baseUrl}/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/?state__group=${stateGroup}`;
    const response = await fetch(url, {
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Plane API returned ${response.status}: ${response.statusText}`);
    }
    const data = (await response.json()) as { results?: PlaneIssue[] };
    return data.results ?? [];
  }

  /**
   * @description Transitions a Plane issue to a target state group.
   */
  private async transitionIssueState(
    baseUrl: string, apiKey: string, workspaceSlug: string, projectId: string,
    issueId: string, targetStateGroup: string,
  ): Promise<void> {
    // First, get the project states to find the state ID for the target group
    const statesUrl = `${baseUrl}/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/states/`;
    const statesRes = await fetch(statesUrl, {
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    });
    if (!statesRes.ok) {
      logger.warn({ status: statesRes.status }, 'Failed to fetch Plane states — skipping transition');
      return;
    }
    const statesData = (await statesRes.json()) as { results?: Array<{ id: string; group: string }> };
    const targetState = (statesData.results ?? []).find((s) => s.group === targetStateGroup);
    if (!targetState) {
      logger.warn({ targetStateGroup }, 'No matching Plane state found — skipping transition');
      return;
    }

    // PATCH the issue with the new state
    const patchUrl = `${baseUrl}/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`;
    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: targetState.id }),
    });
    if (!patchRes.ok) {
      logger.warn({ status: patchRes.status, issueId, targetStateGroup }, 'Failed to transition Plane issue state');
    } else {
      logger.info({ issueId, targetStateGroup }, 'Transitioned Plane issue state');
    }
  }

  /**
   * @description Formats a completion comment for posting to Plane.
   */
  private formatCompletionComment(
    title: string,
    payload?: { summary?: string; deliverables?: string[] },
  ): string {
    const parts = [`✅ **Completed:** ${title}`];
    if (payload?.summary) parts.push(`\n**Summary:** ${payload.summary}`);
    if (payload?.deliverables?.length) {
      parts.push('\n**Deliverables:**');
      payload.deliverables.forEach((d) => parts.push(`- ${d}`));
    }
    parts.push(`\n*Completed at ${new Date().toISOString()} by OSHAL swarm*`);
    return parts.join('\n');
  }

  /**
   * @description Pulls issues from Plane and creates/updates corresponding internal tickets.
   * Uses external_provider='plane' and external_id to deduplicate.
   * @returns Number of tickets created or updated
   */
  async pullTickets(): Promise<{ created: number; updated: number }> {
    if (!this.config) {
      throw new Error('PlaneSyncService not configured — call configure() first');
    }

    logger.info('Pulling tickets from Plane');
    const { baseUrl, apiKey, workspaceSlug, projectId } = this.config;

    let created = 0;
    let updated = 0;

    try {
      const url = `${baseUrl}/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/`;
      const response = await fetch(url, {
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Plane API returned ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as { results?: PlaneIssue[] };
      const issues = data.results ?? [];

      for (const issue of issues) {
        const existing = await this.ticketService.getTicketByExternalId('plane', issue.id);

        if (existing) {
          await this.ticketService.updateTicket(existing.ticketId, {
            title: issue.name,
            description: issue.description ?? '',
            labels: issue.label_detail?.map((l: { name: string }) => l.name) ?? [],
          });
          updated++;
        } else {
          const parsed = CreateInternalTicketSchema.parse({
            title: issue.name,
            description: issue.description ?? '',
            status: mapPlaneStateToOshal(issue.state_detail?.group),
            priority: mapPlanePriority(issue.priority),
            labels: issue.label_detail?.map((l: { name: string }) => l.name) ?? [],
            externalProvider: 'plane',
            externalId: issue.id,
            externalUrl: `${baseUrl}/${workspaceSlug}/projects/${projectId}/issues/${issue.id}`,
          });
          await this.ticketService.createTicket(parsed);
          created++;
        }
      }

      logger.info({ created, updated, total: issues.length }, 'Plane pull complete');
    } catch (error) {
      logger.error({ err: error }, 'Failed to pull tickets from Plane');
      throw error;
    }

    return { created, updated };
  }

  /**
   * @description Pushes an internal ticket status update to Plane.
   * @param ticketId - Internal ticket identifier
   * @param update - Fields to push (status, comment, etc.)
   */
  async pushUpdate(ticketId: string, update: { status?: OshalTicketState; comment?: string }): Promise<void> {
    if (!this.config) {
      throw new Error('PlaneSyncService not configured — call configure() first');
    }

    const ticket = await this.ticketService.getTicket(ticketId);
    if (!ticket || !ticket.externalId || ticket.externalProvider !== 'plane') {
      logger.warn({ ticketId }, 'Ticket not found or not a Plane ticket — skipping push');
      return;
    }

    const { baseUrl, apiKey, workspaceSlug, projectId } = this.config;
    logger.info({ ticketId, externalId: ticket.externalId }, 'Pushing update to Plane');

    try {
      if (update.comment) {
        await this.pushComment(baseUrl, apiKey, workspaceSlug, projectId, ticket.externalId, update.comment);
      }
      logger.info({ ticketId }, 'Plane push complete');
    } catch (error) {
      logger.error({ err: error, ticketId }, 'Failed to push update to Plane');
      throw error;
    }
  }

  /**
   * @description Performs bidirectional state reconciliation for a single ticket.
   * @param ticketId - Internal ticket identifier
   */
  async syncTicketState(ticketId: string): Promise<void> {
    if (!this.config) {
      throw new Error('PlaneSyncService not configured — call configure() first');
    }

    const ticket = await this.ticketService.getTicket(ticketId);
    if (!ticket || !ticket.externalId || ticket.externalProvider !== 'plane') {
      return;
    }

    logger.info({ ticketId, externalId: ticket.externalId }, 'Syncing ticket state with Plane');

    try {
      const { baseUrl, apiKey, workspaceSlug, projectId } = this.config;
      const url = `${baseUrl}/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${ticket.externalId}/`;
      const response = await fetch(url, {
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Failed to fetch Plane issue for sync');
        return;
      }

      const issue = (await response.json()) as PlaneIssue;
      const planeState = mapPlaneStateToOshal(issue.state_detail?.group);

      if (planeState !== ticket.status) {
        logger.info({ ticketId, internalStatus: ticket.status, planeStatus: planeState }, 'State mismatch — updating internal ticket');
        try {
          await this.ticketService.updateStatus(ticketId, planeState);
        } catch (error) {
          logger.warn({ err: error }, 'State transition from Plane rejected — keeping internal state');
        }
      }
    } catch (error) {
      logger.error({ err: error, ticketId }, 'Failed to sync ticket state with Plane');
    }
  }

  /**
   * @description Posts a comment to a Plane issue.
   * @param baseUrl - Plane base URL
   * @param apiKey - Plane API key
   * @param workspaceSlug - Plane workspace slug
   * @param projectId - Plane project ID
   * @param issueId - Plane issue ID
   * @param comment - Comment text
   */
  private async pushComment(
    baseUrl: string,
    apiKey: string,
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    comment: string,
  ): Promise<void> {
    const url = `${baseUrl}/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment_html: `<p>${comment}</p>` }),
    });
    if (!response.ok) {
      throw new Error(`Plane comment API returned ${response.status}`);
    }
  }
}

/**
 * @description Minimal Plane issue shape for sync operations.
 */
interface PlaneIssue {
  id: string;
  name: string;
  description?: string;
  priority: number | null;
  state_detail?: { group: string };
  label_detail?: Array<{ name: string }>;
}

/**
 * @description Maps Plane state group to canonical OshalTicketState.
 * @param group - Plane state group name
 * @returns Canonical ticket state
 */
function mapPlaneStateToOshal(group: string | undefined): OshalTicketState {
  switch (group) {
    case 'backlog': return 'backlog';
    case 'unstarted': return 'approved';
    case 'started': return 'in_process_build';
    case 'completed': return 'complete';
    case 'cancelled': return 'escalated';
    default: return 'backlog';
  }
}

/**
 * @description Maps Plane priority number to canonical ticket priority.
 * @param priority - Plane priority (0=none, 1=urgent, 2=high, 3=medium, 4=low)
 * @returns Canonical priority string
 */
function mapPlanePriority(priority: number | null): 'urgent' | 'high' | 'medium' | 'low' | 'none' {
  switch (priority) {
    case 1: return 'urgent';
    case 2: return 'high';
    case 3: return 'medium';
    case 4: return 'low';
    default: return 'none';
  }
}