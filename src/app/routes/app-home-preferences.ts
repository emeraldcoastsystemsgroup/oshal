/**
 * CHANGE LOG
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | Codex | Persist bounded Home display preferences by authenticated subject with revision conflicts.
 */
import { Router } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import { getCaller, hasAuthenticatedUserIdentity } from '@/shared/middleware/authz';

type CardPreference = { metricOrder?: string[]; hiddenMetrics?: string[]; shownMetrics?: string[]; compact?: boolean; showItems?: boolean; showSetup?: boolean };
type HomePreferences = { version: 1; suiteOrder?: string[]; hiddenSuites?: string[]; collapsedSuites?: string[]; appOrder?: string[]; hiddenApps?: string[]; cards?: Record<string, CardPreference> };
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,127}$/;
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));

function ids(value: unknown, cap: number): string[] {
  if (!Array.isArray(value) || value.length > cap || value.some(v => typeof v !== 'string' || !ID.test(v))) throw new Error('Invalid display ids');
  return [...new Set(value)] as string[];
}

/** @description Validate only display choices; reject unknown keys rather than storing arbitrary data.
 * @param value Untrusted preferences. @returns Bounded preferences or throws. */
export function parseHomePreferences(value: unknown): HomePreferences {
  if (!record(value) || value.version !== 1 || JSON.stringify(value).length > 65536) throw new Error('Invalid Home preferences');
  const allowed = ['version', 'suiteOrder', 'hiddenSuites', 'collapsedSuites', 'appOrder', 'hiddenApps', 'cards'];
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unknown preference');
  const out: HomePreferences = { version: 1 };
  for (const key of ['suiteOrder', 'hiddenSuites', 'collapsedSuites', 'appOrder', 'hiddenApps'] as const) {
    if (value[key] !== undefined) out[key] = ids(value[key], 256);
  }
  if (value.cards !== undefined) {
    if (!record(value.cards) || Object.keys(value.cards).length > 256) throw new Error('Invalid cards');
    out.cards = {};
    for (const [name, card] of Object.entries(value.cards)) {
      if (!ID.test(name) || !record(card) || Object.keys(card).some(k => !['metricOrder', 'hiddenMetrics', 'shownMetrics', 'compact', 'showItems', 'showSetup'].includes(k))) throw new Error('Invalid card');
      const clean: CardPreference = {};
      for (const key of ['metricOrder', 'hiddenMetrics', 'shownMetrics'] as const) if (card[key] !== undefined) clean[key] = ids(card[key], 256);
      for (const key of ['compact', 'showItems', 'showSetup'] as const) {
        if (card[key] !== undefined) {
          if (typeof card[key] !== 'boolean') throw new Error('Invalid switch');
          clean[key] = card[key];
        }
      }
      out.cards[name] = clean;
    }
  }
  return out;
}

/** @description Read preferences with an explicit owner predicate; absence means default-on.
 * @param pool Request-scoped database pool. @param sub Authenticated subject. @returns Preferences and revision. */
export async function readHomePreferences(pool: AppContext['pool'], sub: string) {
  const result = await pool.query('SELECT home_dashboard, home_revision FROM user_preferences WHERE user_id = $1', [sub]);
  const row = result.rows[0];
  return { preferences: parseHomePreferences(row?.home_dashboard ?? { version: 1 }), revision: row?.home_revision ?? 0 };
}

/** @description Compare-and-swap prevents one tab overwriting another user's latest display edits.
 * @param pool Request-scoped database pool. @param sub Authenticated subject. @param preferences Validated choices.
 * @param revision Expected revision. @returns Updated revision, or null on conflict. */
export async function saveHomePreferences(pool: AppContext['pool'], sub: string, preferences: HomePreferences, revision: number): Promise<number | null> {
  const result = await pool.query(`INSERT INTO user_preferences (user_id, home_dashboard, home_revision)
    SELECT $1, $2::jsonb, 1 WHERE $3 = 0 OR EXISTS (SELECT 1 FROM user_preferences WHERE user_id = $1)
    ON CONFLICT (user_id) DO UPDATE SET home_dashboard = EXCLUDED.home_dashboard,
      home_revision = user_preferences.home_revision + 1, updated_at = NOW()
    WHERE user_preferences.home_revision = $3 RETURNING home_revision`, [sub, JSON.stringify(preferences), revision]);
  return result.rows[0]?.home_revision ?? null;
}

/** @description Session-owned Home settings; missing migration fails visibly and GET never creates schema.
 * @param ctx Application database context. @returns Authenticated GET/PUT router. */
export function createAppHomePreferenceRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!hasAuthenticatedUserIdentity(_req)) { res.status(401).json({ error: 'Sign in to customize Home.' }); return; }
    next();
  });
  router.get('/', async (req, res) => {
    try { res.json(await readHomePreferences(ctx.pool, getCaller(req).sub!)); }
    catch { res.status(503).json({ error: 'Home preferences could not be loaded.' }); }
  });
  router.put('/', async (req, res) => {
    let preferences: HomePreferences;
    const revision = req.body?.revision;
    try {
      preferences = parseHomePreferences(req.body?.preferences);
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid revision');
    } catch { res.status(400).json({ error: 'Invalid Home preferences.' }); return; }
    try {
      const next = await saveHomePreferences(ctx.pool, getCaller(req).sub!, preferences, revision);
      if (next === null) { res.status(409).json({ error: 'Home changed in another tab. Refresh before editing again.' }); return; }
      res.json({ preferences, revision: next });
    } catch { res.status(503).json({ error: 'Home preferences could not be saved.' }); }
  });
  return router;
}
