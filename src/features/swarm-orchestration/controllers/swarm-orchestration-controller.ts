/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added swarm orchestration controller for provider processing and run status APIs
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added explicit ticket interaction mode and subticket control to swarm processing requests
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added policy override schema for bounded swarm verification and write-back retries
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added escalation route and retry backoff policy override schema for swarm processing
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added smoke test endpoint for Plane connectivity validation
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added max-cycle guardrails, retry class, escalation severity, and escalation lookup to policy schema
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added escalation query API endpoint for triage dashboards
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Default useStoredCursor and persistCursor to false on process endpoint to prevent stale cursor pagination
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added listRuns and listWorkItems endpoints for operator visibility dashboard
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Prevented the GitHub process shortcut from checkpointing before ticket processing completes
 * 11 | maintainer@emeraldcoastsystemsgroup.com | 2026-07-30 23:07:00 | Added
 *   explicit Express RequestHandler annotations to exported controller handlers so committed-HEAD
 *   declaration typechecking stays portable and does not infer transitive @types/qs paths.
 */

import { randomUUID } from 'crypto';
import { Request, Response, type RequestHandler } from 'express';
import { z } from 'zod';
import { BaseController } from '@/app/base-controller';
import { TicketInteractionModeSchema, buildExternalTicketWorkflow, buildExternalTicketHierarchy } from '@/entities/ticket';
import { IntakeProviderSchema } from '@/shared/types';
import {
  SwarmRuntimeUnavailableError,
  SwarmTicketProcessingService,
  type SwarmProcessingInput,
  type SwarmEscalationStore,
  type SwarmEscalationQuery,
} from '../services';
import type { IntakeService } from '@/features/intake';
import type { WorkItemRepository } from '@/entities/work-item';

const ProviderParamSchema = z.object({
  provider: IntakeProviderSchema,
});

const RunParamSchema = z.object({
  runId: z.string().min(1),
});

const CandidateSchema = z.object({
  agentId: z.string().min(1),
  score: z.number().min(0),
  reason: z.string().min(1),
});

const BidSchema = z.object({
  agentId: z.string().min(1),
  confidence: z.number().min(0).max(1),
  estimatedCost: z.number().min(0),
  estimatedLatencyMs: z.number().min(0),
});

const PolicySchema = z.object({
  maxVerificationAttempts: z.number().int().min(1).max(5).optional(),
  maxBuildRegressions: z.number().int().min(0).max(3).optional(),
  maxDesignRegressions: z.number().int().min(0).max(3).optional(),
  maxWritebackAttempts: z.number().int().min(1).max(5).optional(),
  maxTotalCycles: z.number().int().min(5).max(50).optional(),
  maxRunDurationMs: z.number().int().min(10_000).max(600_000).optional(),
  verificationRetryDelayMs: z.number().int().min(0).max(5000).optional(),
  writebackRetryDelayMs: z.number().int().min(0).max(5000).optional(),
  escalationTarget: z.enum(['human_review', 'team_lead', 'ops_channel']).optional(),
  escalationSeverity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
});

const RunListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

const WorkItemQuerySchema = z.object({
  externalId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
});

const EscalationQuerySchema = z.object({
  runId: z.string().min(1).optional(),
  ticketExternalId: z.string().min(1).optional(),
  target: z.enum(['human_review', 'team_lead', 'ops_channel']).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
});

const SubmitTicketSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional().default(''),
  labels: z.array(z.string()).optional().default([]),
  priority: z.string().optional(),
});

const SubmitTicketsRequestSchema = z.object({
  tickets: z.array(SubmitTicketSchema).min(1).max(50),
  policy: PolicySchema.optional(),
});

const SwarmProcessRequestSchema = z.object({
  interactionMode: TicketInteractionModeSchema.optional().default('ticket'),
  policy: PolicySchema.optional(),
  limit: z.number().int().positive().max(200).optional().default(50),
  cursor: z.string().optional(),
  since: z.string().optional(),
  includeSubtickets: z.boolean().optional().default(false),
  useStoredCursor: z.boolean().optional().default(false),
  persistCursor: z.boolean().optional().default(false),
  tenantId: z.string().optional(),
  workspaceRole: z.string().optional(),
  requiredCapabilities: z.array(z.string().min(1)).max(20).optional(),
  candidates: z.array(CandidateSchema).max(20).optional(),
  bids: z.array(BidSchema).max(20).optional(),
});

/**
 * @description Controller for swarm orchestration processing APIs.
 */
export class SwarmOrchestrationController extends BaseController {
  /**
   * @description Creates swarm orchestration controller.
   * @param processingService - Ticket processing orchestration service
   * @param intakeService - Intake service for smoke test connectivity validation
   * @param logger - Structured logger instance
   */
  constructor(
    private readonly processingService: SwarmTicketProcessingService,
    private readonly intakeService: IntakeService,
    private readonly escalationStore: SwarmEscalationStore,
    logger: unknown,
    private readonly workItemRepository?: WorkItemRepository,
  ) {
    super(logger);
  }

  /**
   * @description POST /api/swarm/providers/:provider/process
   * @param req - Express request
   * @param res - Express response
   * @returns HTTP response with run-level processing summary
   */
  processProvider: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const { provider } = ProviderParamSchema.parse(req.params);
    const parsedBody = SwarmProcessRequestSchema.parse(req.body || {}) as SwarmProcessingInput;
    const body: SwarmProcessingInput = provider === 'github'
      ? { ...parsedBody, persistCursor: false }
      : parsedBody;

    this.logger.info(
      {
        provider,
        interactionMode: body.interactionMode,
        limit: body.limit,
        cursor: body.cursor,
        includeSubtickets: body.includeSubtickets,
      },
      'Swarm provider processing request received',
    );

    try {
      const result = await this.processingService.processProvider(provider, body);

      this.logger.info(
        {
          provider,
          runId: result.runId,
          processedCount: result.processedCount,
          durationMs: Date.now() - startedAt,
        },
        'Swarm provider processing request completed',
      );

      return this.success(res, result);
    } catch (error) {
      if (error instanceof SwarmRuntimeUnavailableError) {
        this.logger.warn(
          { provider, readiness: error.readiness, durationMs: Date.now() - startedAt },
          'Swarm provider processing blocked because runtime dependencies are unavailable',
        );
        return this.serviceUnavailable(res, error.readiness.message, {
          dependency: error.readiness.dependency,
          ...error.readiness.details,
        });
      }
      throw error;
    }
  });

  /**
   * @description GET /api/swarm/runs/:runId
   * @param req - Express request
   * @param res - Express response
   * @returns HTTP response containing run record or 404 when not found
   */
  getRun: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const { runId } = RunParamSchema.parse(req.params);

    this.logger.info({ runId }, 'Swarm run lookup request received');

    const run = await this.processingService.getRun(runId);
    if (!run) {
      this.logger.warn(
        {
          runId,
          durationMs: Date.now() - startedAt,
        },
        'Swarm run lookup request returned not found',
      );
      return this.notFound(res, `Swarm run not found: ${runId}`);
    }

    this.logger.info(
      {
        runId,
        status: run.status,
        itemCount: run.itemCount,
        durationMs: Date.now() - startedAt,
      },
      'Swarm run lookup request completed',
    );

    return this.success(res, run);
  });

  /**
   * @description GET /api/swarm/smoke
   * @param req - Express request
   * @param res - Express response
   * @returns HTTP response with single work item pulled from Plane or error details
   */
  smokeTest: RequestHandler = this.asyncHandler(async (_req: Request, res: Response) => {
    const startedAt = Date.now();

    this.logger.info('Plane connectivity smoke test initiated');

    try {
      const result = await this.intakeService.pull('plane', {
        limit: 1,
        useStoredCursor: false,
        persistCursor: false,
      });

      const responseData = {
        success: true,
        provider: result.provider,
        itemCount: result.items.length,
        source: result.source,
        nextCursor: result.nextCursor,
        effectiveCursor: result.effectiveCursor,
        items: result.items,
        durationMs: Date.now() - startedAt,
      };

      this.logger.info(
        {
          itemCount: result.items.length,
          source: result.source,
          durationMs: responseData.durationMs,
        },
        'Plane connectivity smoke test completed successfully',
      );

      return this.success(res, responseData);
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          durationMs: Date.now() - startedAt,
        },
        'Plane connectivity smoke test failed',
      );

      throw error;
    }
  });

  /**
   * @description GET /api/swarm/escalations
   * @param req - Express request with optional query filters
   * @param res - Express response
   * @returns HTTP response with matching escalation records
   */
  listEscalations: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const query: SwarmEscalationQuery = EscalationQuerySchema.parse(req.query);

    this.logger.info({ ...query }, 'Swarm escalation query received');

    const records = await this.escalationStore.list(query);

    this.logger.info(
      { count: records.length, durationMs: Date.now() - startedAt },
      'Swarm escalation query completed',
    );

    return this.success(res, { escalations: records, count: records.length });
  });

  /**
   * @description GET /api/swarm/runs
   * @param req - Express request with optional limit query parameter
   * @param res - Express response
   * @returns HTTP response with recent run records
   */
  listRuns: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const { limit } = RunListQuerySchema.parse(req.query);
    const runs = await this.processingService.listRuns(limit);
    return this.success(res, { runs, count: runs.length });
  });

  /**
   * @description GET /api/swarm/work-items
   * @param req - Express request with optional externalId, runId, limit query params
   * @param res - Express response
   * @returns HTTP response with work items including execution output and verification results
   */
  listWorkItems: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const query = WorkItemQuerySchema.parse(req.query);

    if (!this.workItemRepository) {
      return this.success(res, { workItems: [], count: 0, message: 'Work item repository not available (no database)' });
    }

    try {
      let items;
      if (query.externalId) {
        items = await this.workItemRepository.findByExternalIdAnyProvider(query.externalId);
      } else if (query.runId) {
        items = await this.workItemRepository.findByRunId(query.runId);
      } else {
        items = await this.workItemRepository.listRecent(query.limit);
      }

      const limited = items.slice(0, query.limit);
      return this.success(res, { workItems: limited, count: limited.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, query }, 'Swarm work item query failed because the repository is unavailable');
      return this.serviceUnavailable(res, 'Work item repository is unavailable', {
        dependency: 'postgres',
        error: message,
      });
    }
  });

  /**
   * @description POST /api/swarm/tickets
   * @param req - Express request with tickets array
   * @param res - Express response
   * @returns HTTP response with processing run result
   */
  submitTickets: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const { tickets: rawTickets, policy } = SubmitTicketsRequestSchema.parse(req.body);

    const tickets = rawTickets.map((t) => {
      const externalId = randomUUID();
      return {
        provider: 'direct' as const,
        externalId,
        title: t.title,
        body: t.body,
        labels: t.labels,
        priority: t.priority,
        status: 'todo',
        actor: {},
        timestamps: { createdAt: new Date().toISOString() },
        workflow: buildExternalTicketWorkflow('approved'),
        hierarchy: buildExternalTicketHierarchy(externalId),
        rawPayload: t,
      };
    });

    this.logger.info({ ticketCount: tickets.length }, 'Direct ticket submission received');

    try {
      const result = await this.processingService.processTickets(tickets, { policy });

      this.logger.info(
        { runId: result.runId, processedCount: result.processedCount },
        'Direct ticket submission completed',
      );

      return this.success(res, result);
    } catch (error) {
      if (error instanceof SwarmRuntimeUnavailableError) {
        this.logger.warn(
          { readiness: error.readiness, ticketCount: tickets.length },
          'Direct ticket submission blocked because runtime dependencies are unavailable',
        );
        return this.serviceUnavailable(res, error.readiness.message, {
          dependency: error.readiness.dependency,
          ...error.readiness.details,
        });
      }
      throw error;
    }
  });
}
