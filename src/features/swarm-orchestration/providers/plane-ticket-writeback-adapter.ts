/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Plane ticket write-back adapter for swarm lifecycle comments and optional status transitions
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Replaced cycle-based Plane state mapping with canonical OSHAL ticket-state projection mapping
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added escalation route detail rendering for Plane lifecycle comments
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Wired CommentFormatter into buildCommentBody for richer, phase-aware Plane comments (legacy CommentFormatter.js parity)
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { toTicketStateEnvSuffix } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import type {
  TicketWritebackAdapter,
  TicketWritebackUpdate,
} from '../services';
import { CommentFormatter } from '../services/comment-formatter';

const logger = createChildLogger({ module: 'plane-ticket-writeback-adapter' });

const COMMENT_PAYLOAD_KEYS = [
  'comment_html',
  'comment',
] as const;

/**
 * @description Plane write-back adapter that reflects swarm lifecycle updates onto Plane issues.
 * Missing configuration degrades to a logged no-op to preserve localhost usability.
 */
export class PlaneTicketWritebackAdapter implements TicketWritebackAdapter {
  readonly provider = 'plane' as const;

  private readonly planeApiUrl = process.env.PLANE_API_URL?.trim();
  private readonly planeApiToken = process.env.PLANE_API_TOKEN?.trim();
  private readonly planeWorkspaceSlug = process.env.PLANE_WORKSPACE_SLUG?.trim();
  private readonly planeProjectId = process.env.PLANE_PROJECT_ID?.trim();
  private readonly planeWritebackUrl = process.env.PLANE_WRITEBACK_URL?.trim();
  private readonly enableStatusTransitions = parseBoolean(process.env.PLANE_WRITEBACK_ENABLE_STATUS_TRANSITIONS);

  /**
   * @description Writes one swarm lifecycle update back to Plane.
   * @param update - Lifecycle update emitted by swarm orchestration
   * @returns Promise resolved after all applicable Plane updates complete
   */
  async writeCycleUpdate(update: TicketWritebackUpdate): Promise<void> {
    const startedAt = Date.now();
    logger.info(
      {
        externalId: update.item.externalId,
        cycle: update.cycle,
        status: update.status,
      },
      'Starting Plane ticket write-back update',
    );

    try {
      const issueUrl = this.resolveIssueUrl(update.item.externalId);
      if (!issueUrl || !this.planeApiToken) {
        logger.info(
          {
            externalId: update.item.externalId,
            hasIssueUrl: Boolean(issueUrl),
            hasToken: Boolean(this.planeApiToken),
            hasPlaneApiUrl: Boolean(this.planeApiUrl),
            hasPlaneWorkspaceSlug: Boolean(this.planeWorkspaceSlug),
            hasPlaneProjectId: Boolean(this.planeProjectId),
            hasPlaneWritebackUrl: Boolean(this.planeWritebackUrl),
          },
          'Skipping Plane ticket write-back because required configuration is missing',
        );
        return;
      }

      await this.writeStatusTransition(issueUrl, update);
      await this.writeComment(issueUrl, update);

      logger.info(
        {
          externalId: update.item.externalId,
          cycle: update.cycle,
          status: update.status,
          durationMs: Date.now() - startedAt,
        },
        'Completed Plane ticket write-back update',
      );
    } catch (error) {
      logger.error(
        {
          err: toError(error),
          externalId: update.item.externalId,
          cycle: update.cycle,
          status: update.status,
        },
        'Plane ticket write-back update failed',
      );
      throw toError(error);
    }
  }

  /**
   * @description Resolves the Plane issue URL for one external issue identifier.
   * @param externalId - Plane issue identifier
   * @returns Issue URL when configuration is available, otherwise null
   */
  private resolveIssueUrl(externalId: string): URL | null {
    const candidate = this.planeWritebackUrl || this.buildDerivedWritebackUrl();
    if (!candidate) {
      return null;
    }

    if (candidate.includes('{externalId}')) {
      return new URL(candidate.replace('{externalId}', encodeURIComponent(externalId)));
    }

    return new URL(appendPath(candidate, `${externalId}/`));
  }

  /**
   * @description Builds the default Plane issue collection URL used for write-back.
   * @returns Base issue collection URL or null when configuration is incomplete
   */
  private buildDerivedWritebackUrl(): string | null {
    if (!this.planeApiUrl || !this.planeWorkspaceSlug || !this.planeProjectId) {
      return null;
    }

    return `${this.planeApiUrl}/api/v1/workspaces/${this.planeWorkspaceSlug}/projects/${this.planeProjectId}/issues/`;
  }

  /**
   * @description Applies a Plane issue state transition when one is configured for the lifecycle update.
   * @param issueUrl - Target Plane issue URL
   * @param update - Lifecycle update
   * @returns Promise resolved after the state patch completes or is skipped
   */
  private async writeStatusTransition(issueUrl: URL, update: TicketWritebackUpdate): Promise<void> {
    const stateId = this.resolveStateId(update);
    if (!stateId) {
      return;
    }

    const response = await fetch(issueUrl, {
      method: 'PATCH',
      headers: this.buildHeaders(),
      body: JSON.stringify({ state_id: stateId }),
    });

    if (!response.ok) {
      throw await buildResponseError(response, 'Plane issue state transition failed');
    }

    logger.info(
      {
        externalId: update.item.externalId,
        cycle: update.cycle,
        status: update.status,
        stateId,
      },
      'Applied Plane issue state transition',
    );
  }

  /**
   * @description Posts a completion or failure comment back onto the Plane issue.
   * @param issueUrl - Target Plane issue URL
   * @param update - Lifecycle update
   * @returns Promise resolved after the comment write completes or is skipped
   */
  private async writeComment(issueUrl: URL, update: TicketWritebackUpdate): Promise<void> {
    if (update.status === 'in_progress') {
      return;
    }

    const commentBody = buildCommentBody(update);
    const commentsUrl = new URL('comments/', issueUrl);

    for (const key of COMMENT_PAYLOAD_KEYS) {
      const response = await fetch(commentsUrl, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ [key]: commentBody }),
      });

      if (response.ok) {
        logger.info(
          {
            externalId: update.item.externalId,
            cycle: update.cycle,
            status: update.status,
            payloadKey: key,
          },
          'Posted Plane lifecycle comment',
        );
        return;
      }

      if (!isRetryableCommentFailure(response.status)) {
        throw await buildResponseError(response, 'Plane issue comment write failed');
      }
    }

    throw new Error('Plane issue comment write failed for all supported payload formats');
  }

  /**
   * @description Builds authenticated request headers for Plane API calls.
   * @returns HTTP headers
   */
  private buildHeaders(): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.planeApiToken}`,
      'X-API-Key': this.planeApiToken ?? '',
    };
  }

  /**
   * @description Resolves the target Plane state identifier for a lifecycle update.
   * @param update - Lifecycle update
   * @returns State identifier or null when no transition should be attempted
   */
  private resolveStateId(update: TicketWritebackUpdate): string | null {
    if (!this.enableStatusTransitions) {
      return null;
    }

    if (!update.targetTicketState) {
      return null;
    }

    const envSuffix = toTicketStateEnvSuffix(update.targetTicketState);
    return process.env[`PLANE_WRITEBACK_STATE_ID_${envSuffix}`]?.trim() ||
      process.env[`PLANE_STATE_ID_${envSuffix}`]?.trim() ||
      null;
  }
}

/**
 * @description Builds a markdown comment body for a lifecycle completion or failure event.
 * @param update - Lifecycle update
 * @returns Comment body string
 */
const commentFormatter = new CommentFormatter();

/**
 * @description Builds a formatted comment body using the CommentFormatter for richer,
 * phase-aware Plane comments. Falls back to structured metadata when formatter
 * doesn't have a specific template for the update type.
 * Ported from the legacy CommentFormatter.js integration in QueueManagerService.js.
 *
 * @param update - Lifecycle update from swarm processing
 * @returns Formatted markdown comment body
 */
function buildCommentBody(update: TicketWritebackUpdate): string {
  const agentId = (update.details as Record<string, unknown>)?.selectedAgentId
    ? String((update.details as Record<string, unknown>).selectedAgentId)
    : 'swarm-agent';
  const phase = (update.details as Record<string, unknown>)?.phase
    ? String((update.details as Record<string, unknown>).phase)
    : undefined;

  // Use CommentFormatter for specific lifecycle events
  if (update.status === 'completed') {
    const content = summarizeDetails(update.details) || `Completed cycle ${update.cycle}`;
    const isParent = Boolean(update.item.hierarchy.parentExternalId);
    return commentFormatter.completionComment(agentId, content, isParent);
  }

  if (update.escalation) {
    return commentFormatter.escalationComment(
      update.escalation.reason,
      agentId,
      (update.lifecycle as unknown as Record<string, unknown>).completedCycles as number | undefined,
    );
  }

  if (update.error) {
    return commentFormatter.errorComment(agentId, update.error, phase);
  }

  // Default: structured metadata comment
  const lines = [
    '## OSHAL swarm lifecycle update',
    `- runId: ${update.runId}`,
    `- ticket: ${update.item.externalId}`,
    `- title: ${update.item.title}`,
    `- cycle: ${update.cycle}`,
    `- status: ${update.status}`,
    `- currentState: ${update.item.workflow.stateLabel}`,
    `- overallStatus: ${update.lifecycle.overallStatus}`,
  ];

  if (update.targetTicketState) {
    lines.push(`- targetState: ${update.targetTicketState}`);
  }
  if (update.item.hierarchy.parentExternalId) {
    lines.push(`- parentTicket: ${update.item.hierarchy.parentExternalId}`);
  }

  const details = summarizeDetails(update.details);
  return details ? `${lines.join('\n')}\n- details: ${details}` : lines.join('\n');
}

/**
 * @description Summarizes structured details into a compact single-line string for provider comments.
 * @param details - Structured cycle details
 * @returns Compact detail summary or empty string
 */
function summarizeDetails(details: Record<string, unknown> | undefined): string {
  if (!details || Object.keys(details).length === 0) {
    return '';
  }

  const serialized = JSON.stringify(details);
  if (!serialized) {
    return '';
  }

  return serialized.length > 400 ? `${serialized.slice(0, 397)}...` : serialized;
}

/**
 * @description Appends a path fragment onto a URL-like string with normalized slashes.
 * @param base - Base URL string
 * @param path - Path fragment to append
 * @returns Joined URL string
 */
function appendPath(base: string, path: string): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${normalizedBase}${path}`;
}

/**
 * @description Builds an Error from an unsuccessful fetch response.
 * @param response - Fetch response object
 * @param message - Base error message
 * @returns Error instance with response context
 */
async function buildResponseError(response: Response, message: string): Promise<Error> {
  const responseBody = await response.text();
  return new Error(`${message} with status ${response.status}: ${responseBody}`);
}

/**
 * @description Determines whether a comment write failure should try the next payload shape.
 * @param status - HTTP status code
 * @returns True when the adapter should try an alternate payload key
 */
function isRetryableCommentFailure(status: number): boolean {
  return status === 400 || status === 404 || status === 422;
}

/**
 * @description Parses boolean-like environment values.
 * @param value - Raw environment value
 * @returns True when the value enables the flag
 */
function parseBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * @description Normalizes unknown throwables to Error instances.
 * @param error - Unknown throwable
 * @returns Error instance
 */
function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === 'string' ? error : 'Unknown Plane write-back error');
}
