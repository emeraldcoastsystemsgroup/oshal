/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of approval workflow service
 */

import { createChildLogger } from '@/shared/logger';
import type {
  ApprovalRequest,
  ApprovalDecision,
  ApprovalStatus,
} from '@/shared/types/tool';
import { StreamManager } from '@/features/streaming';

const logger = createChildLogger({ module: 'approval-workflow' });

/** @description Default approval timeout in milliseconds */
const DEFAULT_TIMEOUT_MS = 60_000;

/** @description SSE event types for the approval workflow */
export const APPROVAL_EVENTS = {
  REQUEST: 'tool:approval:request',
  RESPONSE: 'tool:approval:response',
  TIMEOUT: 'tool:approval:timeout',
} as const;

/**
 * @description Dependencies for the ApprovalWorkflowService
 */
export interface ApprovalWorkflowDeps {
  streamManager: StreamManager;
}

/**
 * @description In-memory pending approval tracker.
 * Maps requestId → { resolve callback, timeout handle }
 */
interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  request: ApprovalRequest;
}

/**
 * @description Manages the approval workflow for tools with auth_mode='ask'.
 * Creates approval requests, emits SSE events, and waits for user decisions.
 */
export class ApprovalWorkflowService {
  private readonly streamManager: StreamManager;
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(deps: ApprovalWorkflowDeps) {
    this.streamManager = deps.streamManager;
    logger.info('ApprovalWorkflowService initialized');
  }

  /**
   * @description Creates an approval request and waits for a user decision.
   * Emits an SSE event to the client and returns a promise that resolves
   * when the user approves, denies, or the timeout expires.
   *
   * @param params - Parameters for the approval request
   * @returns The user's approval decision
   */
  async requestApproval(params: {
    taskId: string;
    agentId: string;
    toolId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    timeoutMs?: number;
    context?: Record<string, unknown>;
  }): Promise<ApprovalDecision> {
    const requestId = crypto.randomUUID();
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const request: ApprovalRequest = {
      requestId,
      taskId: params.taskId,
      agentId: params.agentId,
      toolId: params.toolId,
      toolName: params.toolName,
      toolInput: params.toolInput,
      status: 'pending' as ApprovalStatus,
      requestedAt: new Date(),
      timeoutMs,
      context: params.context ?? {},
    };

    logger.info(
      { requestId, toolName: params.toolName, agentId: params.agentId, timeoutMs },
      'Approval request created',
    );

    return this.waitForDecision(request);
  }

  /**
   * @description Resolves a pending approval request with a user decision.
   * Called when the user clicks approve/deny in the UI.
   *
   * @param decision - The approval decision from the user
   * @returns Whether the decision was applied (false if request not found/expired)
   */
  resolveApproval(decision: ApprovalDecision): boolean {
    const pending = this.pendingApprovals.get(decision.requestId);
    if (!pending) {
      logger.warn(
        { requestId: decision.requestId },
        'Approval resolution for unknown or expired request',
      );
      return false;
    }

    clearTimeout(pending.timeoutHandle);
    this.pendingApprovals.delete(decision.requestId);

    const status = decision.approved ? 'approved' : 'denied';
    logger.info(
      { requestId: decision.requestId, status, decidedBy: decision.decidedBy },
      'Approval request resolved',
    );

    this.broadcastResponse(pending.request, decision);
    pending.resolve(decision);
    return true;
  }

  /**
   * @description Returns count of currently pending approval requests.
   * @returns Number of pending approvals
   */
  getPendingCount(): number {
    return this.pendingApprovals.size;
  }

  /**
   * @description Cancels all pending approvals (e.g., on shutdown).
   */
  cancelAll(): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      clearTimeout(pending.timeoutHandle);
      const decision: ApprovalDecision = {
        requestId,
        approved: false,
        decidedBy: 'system',
        reason: 'Service shutdown — all pending approvals cancelled',
      };
      pending.resolve(decision);
    }
    this.pendingApprovals.clear();
    logger.info('All pending approvals cancelled');
  }

  /**
   * @description Registers the promise and timeout for a pending approval.
   */
  private waitForDecision(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.handleTimeout(request.requestId);
      }, request.timeoutMs);

      this.pendingApprovals.set(request.requestId, {
        resolve,
        timeoutHandle,
        request,
      });

      this.broadcastRequest(request);
    });
  }

  /**
   * @description Handles approval timeout — auto-denies the request.
   */
  private handleTimeout(requestId: string): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      return;
    }

    this.pendingApprovals.delete(requestId);

    logger.warn(
      { requestId, toolName: pending.request.toolName },
      'Approval request timed out — auto-denied',
    );

    const decision: ApprovalDecision = {
      requestId,
      approved: false,
      decidedBy: 'system',
      reason: `Approval timed out after ${pending.request.timeoutMs}ms`,
    };

    this.broadcastTimeout(pending.request);
    pending.resolve(decision);
  }

  /**
   * @description Broadcasts an approval request event via SSE.
   */
  private broadcastRequest(request: ApprovalRequest): void {
    this.streamManager.broadcast(request.taskId, APPROVAL_EVENTS.REQUEST, {
      requestId: request.requestId,
      toolName: request.toolName,
      toolInput: request.toolInput,
      timeoutMs: request.timeoutMs,
      context: request.context,
      requestedAt: request.requestedAt.toISOString(),
    });
  }

  /**
   * @description Broadcasts an approval response event via SSE.
   */
  private broadcastResponse(
    request: ApprovalRequest,
    decision: ApprovalDecision,
  ): void {
    this.streamManager.broadcast(request.taskId, APPROVAL_EVENTS.RESPONSE, {
      requestId: request.requestId,
      toolName: request.toolName,
      approved: decision.approved,
      decidedBy: decision.decidedBy,
      reason: decision.reason,
    });
  }

  /**
   * @description Broadcasts an approval timeout event via SSE.
   */
  private broadcastTimeout(request: ApprovalRequest): void {
    this.streamManager.broadcast(request.taskId, APPROVAL_EVENTS.TIMEOUT, {
      requestId: request.requestId,
      toolName: request.toolName,
      timeoutMs: request.timeoutMs,
    });
  }
}