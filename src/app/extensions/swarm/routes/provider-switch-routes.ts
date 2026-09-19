/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The fleet-default switch surface for "a bot's LLM provider is a row in a table" (operator acceptance, 2026-09-17: moving the whole fleet back to Codex is ONE write of the fleet-default row from the cockpit — no pull request, no image deploy, no container restart). GET reports the fleet row, the snapshot's freshness and the accepted provider ids; PUT validates the id against the REAL runnable catalog (classifyProviderId — an unknown id is a 400 carrying the reason and the accepted list, never a silent write), upserts the one reserved row under the caller's identity (the table's operator-only policy is the enforcement, not this file), and refreshes the installed snapshot so the next dispatch carries it; DELETE clears it so resolution falls to the registry literal. Operator browser sessions only: a service secret is refused exactly as the per-bot runtime writes refuse it.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The per-bot switch rows live in the same table now (migration 147 entry 2: a row an operator wrote through PUT /:agentId/runtime, the only per-bot record that beats the fleet default). GET lists them as perBot so an operator can see which bots hold their own row and who wrote it; DELETE takes the scope — 'fleet-default' as before, or an agent id to release that bot back to the fleet default — and refreshes the snapshot. The PUT stays fleet-only: a per-bot write goes through the runtime route, which pushes to the bot first (ADR-034) and then writes the row.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | A Cline-backed id (gemini, anthropic, ...) written to the fleet default without a modelId is refused 400 model_required with the reason and nothing is written — the Cline runtime would otherwise fall back to the container's FORCE_LLM_MODEL seed (gpt-5.5), the exact 'models/gpt-5.5 is not found' failure by another door. Native ids (codex-cli, claude-code) may still omit the model.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | PUT accepts fallbackOrder: the administrator names as many providers as they want, in the order they want, in the same write that sets the provider. Every rung is validated against the same runnable catalog as the provider id, and a rung equal to the selected provider is refused, so a chain cannot silently do nothing when it is finally needed. Omitting the field leaves an existing chain untouched; [] is an explicit "no failover".
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | The "a provider cannot fail over to itself" refusal compared SPELLINGS and therefore missed every alias. classifyProviderId deliberately answers with the id as written, so codex-cli and openai-codex - one harness, two spellings - compared unequal, and a chain naming its own primary through an alias was accepted 200, stored, and reported by the cockpit as a failover that can never fire. Both the refusal and the dedupe now compare harnessType plus the Cline backing id.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getCaller, hasAuthenticatedUserIdentity, hasValidServiceSecret, requiresOperator } from '@/shared/middleware/authz';
import { FLEET_DEFAULT_SWITCH_ID, classifyProviderId, requireModelForClineBackedId, type ProviderSwitchCatalog } from '@/shared/llm-runtime';
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
    const rows = await deps.store.listAll();
    res.json({
      success: true,
      fleetDefault: rows.find((row) => row.scopeId === FLEET_DEFAULT_SWITCH_ID) ?? null,
      // The bots that hold their own row (and who wrote it): these do NOT follow the fleet default.
      perBot: rows.filter((row) => row.scopeId !== FLEET_DEFAULT_SWITCH_ID),
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
  // Absent leaves any existing chain alone; an explicit array (including []) replaces it.
  const fallbackRaw = body.fallbackOrder === undefined ? undefined
    : Array.isArray(body.fallbackOrder) ? body.fallbackOrder.map((entry) => String(entry ?? '').trim()).filter(Boolean)
    : null;
  logger.info({ providerId, modelId, fallbackOrder: fallbackRaw }, 'Fleet-default switch write started');
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
    // A Cline-backed id with no model would run on the container's FORCE_LLM_MODEL seed: refused,
    // never defaulted.
    const modelLess = requireModelForClineBackedId(classified, modelId);
    if (modelLess) {
      res.status(400).json({ success: false, applied: false, code: 'model_required', error: modelLess.reason });
      return;
    }
    if (fallbackRaw === null) {
      res.status(400).json({
        success: false, applied: false, code: 'fallback_order_invalid',
        error: 'fallbackOrder must be an array of provider ids (use [] for "no failover", or omit it to leave the chain unchanged)',
      });
      return;
    }
    // Every rung is validated against the SAME runnable catalog as the provider itself, so an
    // administrator cannot write a chain that silently does nothing at 3am.
    // Compare on the classified IDENTITY, never on the spelling. classifyProviderId answers with
    // the id AS WRITTEN (so a row keeps the catalog's own casing), which meant `codex-cli` and
    // `openai-codex` — one harness, two spellings — compared unequal: a chain naming its own
    // primary through an alias was accepted 200, stored, and reported back by the cockpit as a
    // working failover that can never fire. Same for the dedupe, which kept both spellings.
    const identityOf = (c: { harnessType?: string; clineApiProvider?: string | null }): string =>
      `${c.harnessType ?? ''}|${(c.clineApiProvider ?? '').toLowerCase()}`;
    const primaryIdentity = identityOf(classified);
    const chain: string[] = [];
    const seenIdentities = new Set<string>();
    for (const entry of fallbackRaw ?? []) {
      const rung = classifyProviderId(entry, catalog);
      if (!rung.ok) {
        res.status(400).json({
          success: false, applied: false, code: 'fallback_order_invalid',
          error: `fallbackOrder entry "${entry}": ${rung.reason}`, accepted: acceptedIds(catalog),
        });
        return;
      }
      const identity = identityOf(rung);
      if (identity === primaryIdentity) {
        res.status(400).json({
          success: false, applied: false, code: 'fallback_order_invalid',
          error: `fallbackOrder entry "${entry}" is the selected provider `
            + `(${classified.providerId}) — a provider cannot fail over to itself`,
        });
        return;
      }
      if (seenIdentities.has(identity)) continue;
      seenIdentities.add(identity);
      chain.push(rung.providerId);
    }
    const updatedBy = getCaller(req).sub ?? 'operator';
    const row = await deps.store.upsert(
      FLEET_DEFAULT_SWITCH_ID, classified.providerId, modelId, updatedBy,
      fallbackRaw === undefined ? undefined : chain,
    );
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

/**
 * Remove one switch row: the fleet default (resolution falls to the registry literal) or a bot's
 * own row (that bot rejoins the fleet default). The scope is the URL segment as written; an
 * unknown scope simply removes nothing and says so (removed:false).
 */
async function handleRemove(res: Response, deps: ProviderSwitchRouteDeps, scopeId: string): Promise<void> {
  const startedAt = Date.now();
  logger.info({ scopeId }, 'Provider switch clear started');
  try {
    if (!deps.store) {
      res.status(503).json({ success: false, applied: false, error: 'Provider switch store unavailable (no Postgres pool)' });
      return;
    }
    const removed = await deps.store.remove(scopeId);
    await deps.snapshot()?.refresh();
    const fleetDefault = scopeId === FLEET_DEFAULT_SWITCH_ID ? null : await deps.store.get(FLEET_DEFAULT_SWITCH_ID);
    res.json({ success: true, applied: true, removed, scopeId, fleetDefault, snapshot: deps.snapshot()?.status() ?? null });
  } catch (err) {
    logger.error({ err, scopeId }, 'Failed to clear the provider switch row');
    res.status(500).json({ success: false, applied: false, error: (err as Error).message });
  } finally {
    logger.info({ scopeId, statusCode: res.statusCode, durationMs: Date.now() - startedAt }, 'Provider switch clear completed');
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
 * @description The LLM provider switch routes, mounted under /api/agents: GET /provider-switch
 * (the fleet row, the per-bot rows, the snapshot status and the accepted ids),
 * PUT /provider-switch/fleet-default (ONE write moves every bot without its own row), and
 * DELETE /provider-switch/:scopeId — 'fleet-default' to clear the fleet, or an agent id to
 * release that bot's own row back to the fleet default.
 * @param deps - Store, installed snapshot and catalog accessors.
 * @returns The router.
 */
export function createProviderSwitchRoutes(deps: ProviderSwitchRouteDeps): Router {
  const router = Router();
  router.get('/provider-switch', requiresOperatorBrowser, (_req, res) => void handleRead(res, deps));
  router.put('/provider-switch/fleet-default', requiresOperatorBrowser, (req, res) => void handleWrite(req, res, deps));
  router.delete('/provider-switch/:scopeId', requiresOperatorBrowser, (req, res) => void handleRemove(res, deps, String(req.params.scopeId)));
  return router;
}
