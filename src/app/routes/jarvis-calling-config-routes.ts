/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add owner-scoped, explicit-opt-in app configuration backed by existing Twilio connections.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Standard Change Log block, JSDoc on the export, a module logger, and error logging in both catch paths (they answered 503 silently). The router factory was split into module-level readers, a response projection and two handlers, each under 50 lines, with the same queries and responses.
 */
/**
 * Jarvis calling setup only. Selecting a connection never starts a call or exposes its secret.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { AppContext } from '@/app/composition/app-context';
import { getCaller } from '@/shared/middleware/authz';
import { createChildLogger } from '@/shared/logger';
import { getUserTenantIds } from './connector-tenancy';

const logger = createChildLogger({ module: 'jarvis-calling-config-routes' });

const Phone = z.string().regex(/^\+[1-9]\d{6,14}$/);
const ConfigInput = z.object({
  connectionId: z.string().uuid().nullable(),
  enabled: z.boolean(),
  transferPhone: Phone.nullable(),
  maxMinutes: z.number().int().min(1).max(60),
  maxCostCents: z.number().int().min(100).max(50000),
  consent: z.boolean(),
}).strict();

type Pool = AppContext['pool'];
interface Choice { id: string; label: string; scope: 'personal' | 'shared'; }
interface StoredConfig {
  connection_id: string | null;
  enabled: boolean;
  transfer_phone: string | null;
  max_minutes: number;
  max_cost_cents: number;
  consented_at: Date | string | null;
}
const DEFAULT_CONFIG: StoredConfig = {
  connection_id: null, enabled: false, transfer_phone: null,
  max_minutes: 20, max_cost_cents: 500, consented_at: null,
};

function page(file: string): string | null {
  return [resolve(process.cwd(), 'src/pages/jarvis-calling', file),
    resolve(__dirname, '../../pages/jarvis-calling', file)].find((candidate) => existsSync(candidate)) ?? null;
}

/** Connected Twilio connections the caller owns personally or shares through a tenant membership. */
async function loadChoices(pool: Pool, sub: string): Promise<Choice[]> {
  const tenantIds = await getUserTenantIds(pool, sub);
  const rows = await pool.query(
    `SELECT connection_id::text AS id, label, account_email, tenant_id
       FROM oshal_connections
      WHERE provider = 'twilio' AND status = 'connected'
        AND ((user_sub = $1 AND tenant_id IS NULL) OR tenant_id = ANY($2::uuid[]))
      ORDER BY created_at, connection_id`, [sub, tenantIds]);
  return rows.rows.map((row: { id: string; label: string | null; account_email: string | null; tenant_id: string | null }) => ({
    id: row.id,
    label: (row.label || row.account_email || 'Twilio connection').slice(0, 100),
    scope: row.tenant_id ? 'shared' as const : 'personal' as const,
  }));
}

async function loadStored(pool: Pool, sub: string): Promise<StoredConfig> {
  const result = await pool.query(
    `SELECT connection_id::text, enabled, transfer_phone, max_minutes, max_cost_cents, consented_at
       FROM jarvis_calling_settings WHERE user_sub = $1`, [sub]);
  return result.rows[0] ?? DEFAULT_CONFIG;
}

/** Calling is never effective from this screen: live_calling_not_installed is always a blocker. */
function projectConfig(config: StoredConfig, available: Choice[]) {
  const selectedAvailable = !!config.connection_id && available.some((choice) => choice.id === config.connection_id);
  const blockedReasons = [
    ...(!config.enabled ? ['application_disabled'] : []),
    ...(!config.connection_id ? ['connection_not_selected'] : !selectedAvailable ? ['connection_unavailable'] : []),
    ...(!config.transfer_phone ? ['transfer_phone_missing'] : []),
    'live_calling_not_installed',
  ];
  return {
    config: {
      connectionId: config.connection_id, enabled: config.enabled,
      transferPhone: config.transfer_phone, maxMinutes: config.max_minutes,
      maxCostCents: config.max_cost_cents, consented: !!config.consented_at,
    },
    connections: available,
    selectedConnectionAvailable: selectedAvailable,
    effectiveEnabled: false,
    blockedReasons,
  };
}

function sameOriginJson(req: Request): boolean {
  return req.get('origin') === `${req.protocol}://${req.get('host')}` && req.get('sec-fetch-site') !== 'cross-site'
    && req.get('x-oshal-calling-config') === '1' && !!req.is('application/json');
}

function handleGetConfig(pool: Pool): RequestHandler {
  return async (req: Request, res: Response) => {
    const sub = getCaller(req).sub!;
    try {
      const [config, available] = await Promise.all([loadStored(pool, sub), loadChoices(pool, sub)]);
      res.json(projectConfig(config, available));
    } catch (err) {
      logger.error({ err }, 'Jarvis calling configuration read failed');
      res.status(503).json({ error: 'calling_configuration_unavailable' });
    }
  };
}

function handlePutConfig(pool: Pool): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!sameOriginJson(req)) { res.status(403).json({ error: 'same_origin_json_required' }); return; }
    const parsed = ConfigInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'invalid_calling_configuration' }); return; }
    const input = parsed.data;
    if (input.enabled && (!input.connectionId || !input.transferPhone || !input.consent)) {
      res.status(400).json({ error: 'connection_phone_and_consent_required' }); return;
    }
    const sub = getCaller(req).sub!;
    try {
      const available = await loadChoices(pool, sub);
      if (input.connectionId && !available.some((choice) => choice.id === input.connectionId)) {
        res.status(409).json({ error: 'twilio_connection_unavailable' }); return;
      }
      await pool.query(
        `INSERT INTO jarvis_calling_settings
           (user_sub, connection_id, enabled, transfer_phone, max_minutes, max_cost_cents, consented_at)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, CASE WHEN $3 THEN NOW() ELSE NULL END)
         ON CONFLICT (user_sub) DO UPDATE SET
           connection_id = EXCLUDED.connection_id, enabled = EXCLUDED.enabled,
           transfer_phone = EXCLUDED.transfer_phone, max_minutes = EXCLUDED.max_minutes,
           max_cost_cents = EXCLUDED.max_cost_cents, consented_at = EXCLUDED.consented_at,
           updated_at = NOW()`,
        [sub, input.connectionId, input.enabled, input.transferPhone, input.maxMinutes, input.maxCostCents]);
      res.json(projectConfig(await loadStored(pool, sub), available));
    } catch (err) {
      logger.error({ err }, 'Jarvis calling configuration save failed');
      res.status(503).json({ error: 'calling_configuration_unavailable' });
    }
  };
}

function sendPage(file: string, type?: string): RequestHandler {
  return (_req: Request, res: Response) => {
    const found = page(file);
    if (!found) { res.status(404).send('Not found'); return; }
    if (type) res.type(type);
    res.sendFile(found);
  };
}

/**
 * @description Owner-scoped Jarvis calling setup: GET/PUT /config plus the /settings page and its
 * client script. Configuration is per signed-in person; a shared household connection still needs
 * that person's opt-in, and a saved configuration never makes calling effective here.
 * @param pool - Database pool used for connection choices and the jarvis_calling_settings row.
 * @param requiresAuth - Session gate applied to every route of this router.
 * @returns Express router to mount at /api/jarvis/calling.
 */
export function createJarvisCallingConfigRoutes(pool: Pool, requiresAuth: RequestHandler): Router {
  const router = Router();
  router.use(requiresAuth);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
  router.use((req, res, next) => {
    if (!getCaller(req).sub) { res.status(401).json({ error: 'signed_in_owner_required' }); return; }
    next();
  });
  router.get('/settings', sendPage('index.html'));
  router.get('/client.js', sendPage('client.js', 'application/javascript'));
  router.get('/config', handleGetConfig(pool));
  router.put('/config', handlePutConfig(pool));
  return router;
}
