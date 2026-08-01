/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added intake controller for provider listing and pull endpoints
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exposed subticket inclusion control on intake pull requests
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exposed crash-safe provider reconciliation that materializes tickets before checkpointing
 * 4 | maintainer@emeraldcoastsystemsgroup.com | 2026-07-30 23:07:00 | Added
 *   explicit Express RequestHandler annotations to exported controller handlers so committed-HEAD
 *   declaration typechecking stays portable and does not infer transitive @types/qs paths.
 */

import { Request, Response, type RequestHandler } from 'express';
import { z } from 'zod';
import { BaseController } from '@/app/base-controller';
import { IntakeProviderSchema, IntakePullRequestSchema } from '@/shared/types';
import {
  IntakeService,
  type IntakeWorkItemMaterializer,
} from '../services';

const IntakeProviderParamSchema = z.object({
  provider: IntakeProviderSchema,
});

/**
 * @description Controller for intake provider endpoints.
 */
export class IntakeController extends BaseController {
  constructor(
    private readonly intakeService: IntakeService,
    logger: unknown,
    private readonly materializeWorkItem?: IntakeWorkItemMaterializer,
  ) {
    super(logger);
  }

  /**
   * @description GET /api/intake/providers - list enabled intake providers.
   */
  listProviders: RequestHandler = this.asyncHandler(async (_req: Request, res: Response) => {
    const providers = this.intakeService.listProviders();
    return this.success(res, {
      providers,
      count: providers.length,
    });
  });

  /**
   * @description POST /api/intake/providers/:provider/pull - preview normalized work without checkpointing.
   */
  pullProvider: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const { provider } = IntakeProviderParamSchema.parse(req.params);
    const body = IntakePullRequestSchema.parse(req.body || {});

    const result = await this.intakeService.pull(provider, {
      ...body,
      persistCursor: false,
    });

    return this.success(res, {
      provider,
      items: result.items,
      count: result.items.length,
      nextCursor: result.nextCursor ?? null,
      effectiveCursor: result.effectiveCursor,
      includeSubtickets: body.includeSubtickets,
      source: result.source,
    });
  });

  /**
   * @description POST /api/intake/providers/:provider/reconcile - upsert pulled work before checkpointing.
   */
  reconcileProvider: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    if (!this.materializeWorkItem) {
      throw new Error('Provider reconciliation is unavailable on this runtime role');
    }
    const { provider } = IntakeProviderParamSchema.parse(req.params);
    const body = IntakePullRequestSchema.parse(req.body || {});
    const result = await this.intakeService.reconcile(
      provider,
      {
        limit: body.limit,
        includeSubtickets: body.includeSubtickets,
        useStoredCursor: true,
        persistCursor: true,
      },
      this.materializeWorkItem,
    );
    return this.success(res, {
      provider,
      items: result.items,
      count: result.items.length,
      materializedTicketIds: result.materializedTicketIds,
      nextCursor: result.nextCursor ?? null,
      effectiveCursor: result.effectiveCursor,
      source: result.source,
    });
  });
}
