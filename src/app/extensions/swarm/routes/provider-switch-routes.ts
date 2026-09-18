/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The fleet-default switch surface for "a bot's LLM provider is a row in a table" (operator acceptance, 2026-09-17: moving the whole fleet back to Codex is ONE write of the fleet-default row from the cockpit — no pull request, no image deploy, no container restart). GET reports the fleet row, the snapshot's freshness and the accepted provider ids; PUT validates the id against the REAL runnable catalog (classifyProviderId — an unknown id is a 400 carrying the reason and the accepted list, never a silent write), upserts the one reserved row under the caller's identity (the table's operator-only policy is the enforcement, not this file), and refreshes the installed snapshot so the next dispatch carries it; DELETE clears it so resolution falls to the registry literal. Operator browser sessions only: a service secret is refused exactly as the per-bot runtime writes refuse it.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getCaller, hasAuthenticatedUserIdentity, hasValidServiceSecret, requiresOperator } from '@/shared/middleware/authz';
import { FLEET_DEFAULT_SWITCH_ID, classifyProviderId, type ProviderSwitchCatalog } from '@/shared/llm-runtime';
import type { ProviderSwitchSnapshot, ProviderSwitchStore } from '@/features/agent-management';

const logger = createChildLogger({ module: 'provider-switch-routes' });

/** What the routes need from the composition root. */
export interface ProviderSwitchRouteDeps {
  /** The store over the (GUC-wrapped) pool; absent without Postgres. */
  store: ProviderSwitchStore | undefined;
  /** The installed snapshot, refreshed after every write; absent until installed. */
  snapshot: () => ProviderSwitchSnapshot | null;
  /** The runnable catalog the snapshot was built with; absent until installed. */
  catalog: () => ProviderSwitchCatalog | null;
}

/** The ids a row may name, for the surface's select and for the refusal message. */
function acceptedIds(catalog: ProviderSwitchCatalog | null): string[] {
  if (!catalog) return [];
  const harnesses = catalog.harnessTypes.filter((h) => h !== 'a2a');
  return Array.from(new Set([...harnesses, ...catalog.clineApiProviders])).sort();
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function handleRead(res: Response, deps: ProviderSwitchRouteDeps): Promise<void> {
  const startedAt = Date.now();
  try {
    if (!deps.store) {
      res.status(503).json({ success: false, error: 'Provider switch store unavailable (no Postgres pool)' });
      return;
    }
    const snapshot = deps.snapshot();
    const fleetDefault = await deps.store.get(FLEET_DEFAULT_SWITCH_ID);
    res.json({
      success: true,
      fleetDefault,
      snapshot: snapshot?.status() ?? null,
      accepted: acceptedIds(deps.catalog()),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to read the fleet-default provider switch');
    res.status(500).json({ success: false, error: (err as Error).message });
  } finally {
    logger.info({ statusCode: res.statusCode, durationMs: Date.now() - startedAt }, 'Fleet-default switch read completed');
  }
}

async function handleWrite(req: Request, res: Response, deps: ProviderSwitchRouteDeps): Promise<void> {
  const startedAt = Date.now();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const providerId = readOptionalString(body.providerId);
  const modelId = readOptionalString(body.modelId);
  logger.info({ providerId, modelId }, 'Fleet-default switch write started');
  try {
    if (!deps.store) {
      res.status(503).json({ success: false, applied: false, error: 'Provider switch store unavailable (no Postgres pool)' });
      return;
    }
    const catalog = deps.catalog();
    if (!catalog) {
      res.status(503).json({ success: false, applied: false, error: 'Provider switch catalog not installed yet — retry after boot' });
      return;
    }
    const classified = classifyProviderId(providerId, catalog);
    if (!classified.ok) {
      res.status(400).json({ success: false, applied: false, error: classified.reason, accepted: acceptedIds(catalog) });
      return;
    }
    const updatedBy = getCaller(req).sub ?? 'operator';
    const row = await deps.store.upsert(FLEET_DEFAULT_SWITCH_ID, classified.providerId, modelId, updatedBy);
    await deps.snapshot()?.refresh();
    res.json({
      success: true, applied: true, fleetDefault: row,
      harnessType: classified.harnessType, apiType: classified.apiType, botNodeRuntime: classified.botNodeRuntime,
      snapshot: deps.snapshot()?.status() ?? null,
    });
  } catch (err) {
    logger.error({ err, providerId }, 'Failed to write the fleet-default provider switch');
    const code = (err as { code?: string }).code;
    const status = code === '42501' ? 403 : code === '23514' ? 400 : 500;
    res.status(status).json({ success: false, applied: false, error: (err as Error).message });
  } finally {
    logger.info({ statusCode: res.statusCode, durationMs: Date.now() - startedAt }, 'Fleet-default switch write completed');
  }
}

async function handleRemove(res: Response, deps: ProviderSwitchRouteDeps): Promise<void> {
  const startedAt = Date.now();
  try {
    if (!deps.store) {
      res.status(503).json({ success: false, applied: false, error: 'Provider switch store unavailable (no Postgres pool)' });
      return;
    }
    const removed = await deps.store.remove(FLEET_DEFAULT_SWITCH_ID);
    await deps.snapshot()?.refresh();
    res.json({ success: true, applied: true, removed, fleetDefault: null, snapshot: deps.snapshot()?.status() ?? null });
  } catch (err) {
    logger.error({ err }, 'Failed to clear the fleet-default provider switch');
    res.status(500).json({ success: false, applied: false, error: (err as Error).message });
  } finally {
    logger.info({ statusCode: res.statusCode, durationMs: Date.now() - startedAt }, 'Fleet-default switch clear completed');
  }
}

/**
 * @description Operator browser sessions only. A service secret is explicitly refused: the fleet
 * switch moves every bot, and a bot-node's own secret must not be able to move the fleet.
 */
function requiresOperatorBrowser(req: Request, res: Response, next: NextFunction): void {
  if (hasAuthenticatedUserIdentity(req)) {
    requiresOperator(req, res, next);
    return;
  }
  if (hasValidServiceSecret(req)) {
    res.status(403).json({ success: false, applied: false, error: 'Operator privilege required' });
    return;
  }
  requiresOperator(req, res, next);
}

/**
 * @description The fleet-default LLM provider switch routes, mounted under /api/agents:
 * GET /provider-switch, PUT /provider-switch/fleet-default, DELETE /provider-switch/fleet-default.
 * @param deps - Store, installed snapshot and catalog accessors.
 * @returns The router.
 */
export function createProviderSwitchRoutes(deps: ProviderSwitchRouteDeps): Router {
  const router = Router();
  router.get('/provider-switch', requiresOperatorBrowser, (_req, res) => void handleRead(res, deps));
  router.put('/provider-switch/fleet-default', requiresOperatorBrowser, (req, res) => void handleWrite(req, res, deps));
  router.delete('/provider-switch/fleet-default', requiresOperatorBrowser, (_req, res) => void handleRemove(res, deps));
  return router;
}
