 /**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 1: /api/haven/chat and /api/haven/context routes
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Phase 1b: Added /api/haven/dispatch — Haven creates tickets and pushes to swarm
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Isolation-audit fix: household resolved per-caller via ADR-042 tenancy rails (oshal_tenant_memberships, same pattern as rag-routes/tenant-routes) instead of trusting a client-supplied householdId; explicit householdId now requires membership (403 otherwise); default household only for callers with no memberships; dispatch confirmation uses the caller's household, not the hardcoded default
 */

import { Router, Request, Response } from 'express';
import {
  HomeContextService,
  HAVEN_DEFAULT_HOUSEHOLD_ID,
  HavenPersonaService,
  type HavenChatMessage,
} from '@/features/haven';
import { createChildLogger } from '@/shared/logger';
import { getUserTenantIds } from './connector-tenancy';

const logger = createChildLogger({ module: 'haven-routes' });

/** Pull the signed-in user's sub from the OIDC session (null if unauthenticated). */
function callerSub(req: Request): string | null {
  const oidc = (req as any).oidc;
  if (!oidc || typeof oidc.isAuthenticated !== 'function' || !oidc.isAuthenticated()) return null;
  const u = oidc.user || {};
  const sub = u.sub || u.oid;
  return sub ? String(sub) : null;
}

/** Outcome of per-caller household resolution: either a household or an HTTP error to return. */
interface HouseholdResolution {
  householdId?: string;
  status?: number;
  error?: string;
}

/**
 * @openapi
 * /api/haven/chat:
 *   post:
 *     summary: Send a message to Haven, the home assistant
 *     tags: [Haven]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [message]
 *             properties:
 *               message:
 *                 type: string
 *                 description: User message to send to Haven
 *               householdId:
 *                 type: string
 *                 description: Optional household ID (defaults to the primary household)
 *               history:
 *                 type: array
 *                 description: Optional prior conversation turns
 *                 items:
 *                   type: object
 *                   properties:
 *                     role:
 *                       type: string
 *                       enum: [user, assistant]
 *                     content:
 *                       type: string
 *     responses:
 *       200:
 *         description: Haven reply
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 reply:
 *                   type: string
 *                 householdId:
 *                   type: string
 *       400:
 *         description: Missing message
 *       500:
 *         description: LLM or DB error
 *
 * /api/haven/context:
 *   get:
 *     summary: Get the current home context snapshot (debug)
 *     tags: [Haven]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: householdId
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Home context snapshot
 */
export function createHavenRoutes(ctx: any): Router {
  const router = Router();

  function buildServices(): { homeCtx: HomeContextService; haven: HavenPersonaService } {
    const homeCtx = new HomeContextService(ctx.pool);
    // Use platform getProvider() — same Codex path as the swarm (avoids raw OpenAI fetch / wrong auth)
    const haven = new HavenPersonaService(homeCtx, ctx.getProvider, ctx.ticketService ?? undefined);
    return { homeCtx, haven };
  }

  /**
   * @description Resolve which household this caller may act on, via the ADR-042 tenancy
   * rails (oshal_tenant_memberships — same resolution rag-routes/tenant-routes use). The
   * allowed set is the caller's tenant (household) ids, or the single-household default
   * ONLY when the caller belongs to no tenant. An explicit `requested` household outside
   * that set is refused with 403 — a client-supplied householdId is never trusted on its own.
   * @param req The authenticated request (OIDC session carries the caller sub).
   * @param requested Optional householdId the client asked for (body/query).
   * @returns The resolved householdId, or an HTTP status + error to return to the caller.
   */
  async function resolveHouseholdId(req: Request, requested?: unknown): Promise<HouseholdResolution> {
    const sub = callerSub(req);
    if (!sub) return { status: 401, error: 'not authenticated' };

    let tenantIds: string[] = [];
    try {
      tenantIds = await getUserTenantIds(ctx.pool, sub);
    } catch (err) {
      // Tenancy schema unavailable (fresh DB) — fall back to the single-household default.
      logger.warn({ err }, 'Haven: tenancy lookup failed — falling back to default household');
    }
    const allowed = tenantIds.length > 0 ? tenantIds : [HAVEN_DEFAULT_HOUSEHOLD_ID];

    const want = typeof requested === 'string' ? requested.trim() : '';
    if (want) {
      if (!allowed.includes(want)) {
        logger.warn({ sub, requested: want }, 'Haven: caller requested a household they are not a member of');
        return { status: 403, error: 'not a member of that household' };
      }
      return { householdId: want };
    }
    return { householdId: allowed[0] };
  }

  /**
   * POST /haven/dispatch
   * Haven understands a user request, confirms scope, creates a ticket,
   * and pushes it into the swarm for execution.
   *
   * Body: { title, description, acceptanceCriteria? }
   * Returns: { ticketId, message } — Haven-voiced confirmation
   */
  router.post('/haven/dispatch', async (req: Request, res: Response) => {
    const { title, description, acceptanceCriteria } = req.body as {
      title?: string;
      description?: string;
      acceptanceCriteria?: string[];
    };

    if (typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ error: 'title is required' });
    }

    if (!ctx.ticketService) {
      return res.status(503).json({ error: 'Ticket service not available' });
    }

    try {
      // Create the ticket via the existing ticket service
      const ticket = await ctx.ticketService.createTicket({
        title: title.trim(),
        description: typeof description === 'string' ? description.trim() : title.trim(),
        metadata: {
          source: 'haven',
          acceptanceCriteria: Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [],
          createdAt: new Date().toISOString(),
        },
      });

      logger.info({ ticketId: ticket.id, title: ticket.title }, 'Haven: dispatched ticket to swarm');

      // Push to swarm mesh if mesh communication service is available
      if (ctx.swarm?.meshCommunicationService) {
        try {
          await ctx.swarm.meshCommunicationService.publishTicket(ticket);
          logger.info({ ticketId: ticket.id }, 'Haven: ticket published to mesh');
        } catch (meshErr) {
          // Non-blocking — ticket is created even if mesh publish fails
          logger.warn({ err: meshErr, ticketId: ticket.id }, 'Haven: mesh publish failed, ticket still created');
        }
      }

      // Build a Haven-voiced confirmation, scoped to the caller's own household
      const resolution = await resolveHouseholdId(req);
      const { haven } = buildServices();
      let confirmationMessage: string;
      try {
        const result = await haven.chat(
          resolution.householdId ?? HAVEN_DEFAULT_HOUSEHOLD_ID,
          `I just started working on: "${title.trim()}". Give me a one-sentence confirmation in your voice that the work is underway and the user will hear back when there's something to show. Don't mention tickets, systems, or routing.`,
        );
        confirmationMessage = result.reply;
      } catch {
        // Fallback confirmation if LLM is unavailable
        confirmationMessage = `On it. I've started work on "${title.trim()}" — I'll check in when there's something to show.`;
      }

      res.json({
        ticketId: ticket.id,
        externalId: ticket.externalId,
        message: confirmationMessage,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Dispatch failed';
      logger.error({ err, title }, 'Haven: dispatch failed');
      res.status(500).json({ error: msg });
    }
  });

  // POST /haven/chat — send a message to Haven
  router.post('/haven/chat', async (req: Request, res: Response) => {
    const { message, householdId, history } = req.body as {
      message?: string;
      householdId?: string;
      history?: HavenChatMessage[];
    };

    if (typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Household comes from the caller's tenancy memberships — a client householdId is
    // only honored when the caller is actually a member of that household.
    const resolution = await resolveHouseholdId(req, householdId);
    if (!resolution.householdId) {
      return res.status(resolution.status ?? 403).json({ error: resolution.error ?? 'forbidden' });
    }

    const sanitizedHistory: HavenChatMessage[] = Array.isArray(history)
      ? history.filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
      : [];

    try {
      const { haven } = buildServices();
      const result = await haven.chat(resolution.householdId, message.trim(), sanitizedHistory);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Haven chat failed';
      res.status(500).json({ error: message });
    }
  });

  // GET /haven/context — return current context snapshot (debug / future dashboard use)
  router.get('/haven/context', async (req: Request, res: Response) => {
    // Same per-caller resolution as chat: membership-checked, never a raw client value.
    const resolution = await resolveHouseholdId(req, req.query.householdId);
    if (!resolution.householdId) {
      return res.status(resolution.status ?? 403).json({ error: resolution.error ?? 'forbidden' });
    }

    try {
      const { homeCtx } = buildServices();
      await homeCtx.ensureHousehold(resolution.householdId);
      const snapshot = await homeCtx.getContextSnapshot(resolution.householdId);
      res.json(snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read home context';
      res.status(500).json({ error: message });
    }
  });

  return router;
}