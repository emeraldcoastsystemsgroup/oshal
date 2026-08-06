/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-058 live wiring: /api/personal — contribute + relate over the Personal-Intelligence Service
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserve and validate the authenticated exact OIDC subject before any vault resolution, rejecting malformed assertions as unauthorized without logging their value.
 */

/**
 * /api/personal — the live surface over the Personal-Intelligence Service (ADR-056/057/058).
 *
 * The PIS is the PRIVATE, deterministic, start-parameter-gated service — not a registered bot. It's
 * instantiated HERE (not threaded through app-context) and gated by ENABLE_PERSONAL_INTELLIGENCE;
 * when disabled, every route 503s.
 *
 * Tenancy: ownerSub is ALWAYS taken from the authenticated session and FORCED onto the contribution —
 * the request body is never trusted for whose vault this touches (the confused-deputy guard, ADR-056).
 */
import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import {
  SqliteVaultStore,
  createPersonalIntelligenceService,
  readPersonalIntelligenceConfig,
  resolveVault,
  SchemaContributionSchema,
} from '@/features/personal-data';
import { requireExactUserSubject } from '@/shared/security/exact-user-subject';

const logger = createChildLogger({ module: 'personal-routes' });

/** OIDC subject of the signed-in user — the vault owner + the broker's scope handle. */
function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user;
  if (u?.sub === undefined) return null;
  try {
    return requireExactUserSubject(u.sub, 'OIDC sub');
  } catch (err) {
    logger.error({ err }, 'personal route rejected an invalid OIDC subject');
    return null;
  }
}

/**
 * @description Builds the exact-owner Personal Intelligence HTTP surface; authentication is
 * applied by the composition root and every filesystem scope comes from the validated session.
 * @returns Router containing the contribute and deterministic read endpoints.
 */
export function createPersonalRoutes(): Router {
  const router = Router();
  const config = readPersonalIntelligenceConfig();          // null when ENABLE_PERSONAL_INTELLIGENCE !== 'true'
  const store = config ? new SqliteVaultStore() : null;
  const pis = config && store ? createPersonalIntelligenceService(store) : null;

  if (pis) logger.info({ storeRoot: config?.storeRoot }, 'Personal-Intelligence Service enabled (/api/personal)');
  else logger.info('Personal-Intelligence Service disabled (set ENABLE_PERSONAL_INTELLIGENCE=true)');

  /** POST /api/personal/contribute — a SchemaContribution; ownerSub is FORCED to the session user. */
  router.post('/contribute', (req: Request, res: Response) => {
    if (!pis) { res.status(503).json({ error: 'personal intelligence disabled' }); return; }
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'unauthorized' }); return; }
    const parsed = SchemaContributionSchema.safeParse({ ...(req.body || {}), ownerSub: sub });
    if (!parsed.success) { res.status(400).json({ error: 'invalid contribution', details: parsed.error.issues }); return; }
    pis.ingest(parsed.data)
      .then((result) => res.json({ ok: true, result }))
      .catch((e) => { logger.error({ err: e }, 'contribute failed'); res.status(500).json({ error: 'ingest failed' }); });
  });

  /** GET /api/personal/relate — the deterministic broker read demo: holdings → securities → sector. */
  router.get('/relate', (req: Request, res: Response) => {
    if (!config || !store) { res.status(503).json({ error: 'personal intelligence disabled' }); return; }
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'unauthorized' }); return; }
    const layout = resolveVault(config.storeRoot, config.tenant, sub);
    res.json({ relations: store.relateHoldingsToSectors(layout, sub) });
  });

  /** GET /api/personal/entities?type= — scoped entity list (read-only, this user's vault only). */
  router.get('/entities', (req: Request, res: Response) => {
    if (!config || !store) { res.status(503).json({ error: 'personal intelligence disabled' }); return; }
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'unauthorized' }); return; }
    const layout = resolveVault(config.storeRoot, config.tenant, sub);
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    res.json({ entities: store.getEntities(layout, sub, type) });
  });

  return router;
}
