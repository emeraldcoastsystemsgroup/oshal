/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add Change Log header; double-start guard + unref-ed timer handles (2026-07-05 leak audit)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3 travel carve: this module now owns the swarm-shared price-history ENGINE that stays kernel-resident (ADR-093) — ensureTravelSchema (runtime fallback for migration 050), routeKeyFor, recordObservations, and priceRead moved here from travel-routes.ts (which carved to the app store; the packaged route imports them back via @/app/routes/travel-farewatch). The cron now ensures the schema at start (previously done by the createTravelRoutes mount at boot).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped the BOOT setTimeout run in runWithSystemIdentity too — only the interval tick was wrapped, so the boot fare-watch sweep still ran identity-less (guc warn-audit site checkAllWatches).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: execute fare-watch Duffel requests with an explicit OS/network environment, exact watcher subject, and exact brokered Duffel token; database/session/controller/provider credentials are no longer inherited.
 */
/**
 * Travel fare-watch + the swarm-shared travel price engine (ADR-059 §2/§5).
 *
 * Two kernel-resident halves (the Travel SURFACE lives in the app-store package, ADR-085):
 *
 * 1. THE PRICE ENGINE — the travel_* store schema fallback (migration 050 is the source),
 *    route keys, anonymized observation writes, and the honest price read over
 *    travel_observations (the swarm-wide price DB other bots read too).
 *
 * 2. THE FARE-WATCH CRON — mirrors feeds-indexing's in-process cron: a first run shortly after
 *    boot, then every TRAVEL_FAREWATCH_INTERVAL_MIN minutes. Each active travel_watches row is
 *    re-priced through scripts/oshal-duffel.js (the same broker-resolved Duffel token as the
 *    surface), which:
 *   - writes fresh ANONYMIZED rows into travel_observations (so the swarm price DB keeps growing
 *     even between user searches), and
 *   - updates the watch's last_price / last_checked_at, flipping it to 'tripped' when the best
 *     price drops to/below the traveller's target (or below the last seen price when no target).
 *
 * The "tripped" flag is what a notifier / the concierge surfaces as "fare drop on your route".
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — re-price active watches on
 *            | an interval, grow the swarm price DB, flag drops. Mirrors startFeedsIndexingCron.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Ran the fare-watch interval under
 *            | runWithSystemIdentity — cross-owner background re-price sweep; SYSTEM keeps it
 *            | visible once OSHAL_DB_GUC_STRICT denies the identity-less case.
 * ---------------------------------------------------------------------------
 * @module travel-farewatch
 */

import * as path from 'path';
import { execFile } from 'child_process';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { AppContext } from '@/app/composition/app-context';
import type { Pool } from 'pg';
import { resolveServerOperationCreds } from './connector-token-broker';

const logger = createChildLogger({ module: 'travel-farewatch' });
const DUFFEL_CLI = 'scripts/oshal-duffel.js';
const TRAVEL_PROVIDER_PROCESS_ENV_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
] as const;

/**
 * Build one fare-watch provider child's environment without controller authority.
 *
 * The already brokered Duffel token and exact watch owner are the complete operation scope.
 * Omitting database and session settings is deliberate: a missing brokered token must degrade
 * as not-connected/demo in the legacy CLI rather than decrypt another credential itself.
 */
export function buildTravelFarewatchProcessEnv(
  userSub: string,
  duffelCredential: string | undefined,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of TRAVEL_PROVIDER_PROCESS_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  env.OSHAL_USER_SUB = userSub;
  if (duffelCredential) env.OSHAL_CRED_DUFFEL = duffelCredential;
  return env;
}

// ── Schema (idempotent fallback for fresh deploys — migration 050 is the source) ─
/**
 * @description Ensures the shared travel store schema exists (runtime fallback —
 * scripts/migrations/050-travel-platform.sql is the source of truth). Kernel-resident
 * because the store is swarm-shared: the fare-watch cron and other bots read it even
 * when the Travel surface package is not installed.
 * @param pool - Postgres pool.
 * @returns resolves when the schema requirements validate.
 */
export async function ensureTravelSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'travel price engine',
    statements: [`
    CREATE TABLE IF NOT EXISTS travel_observations (
      obs_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kind VARCHAR(8) NOT NULL DEFAULT 'flight', route_key VARCHAR(160) NOT NULL,
      origin VARCHAR(8), destination VARCHAR(64), depart_date DATE, return_date DATE,
      cabin VARCHAR(16), carrier VARCHAR(64), price NUMERIC(10,2) NOT NULL,
      currency VARCHAR(8) NOT NULL DEFAULT 'USD', source VARCHAR(16) NOT NULL DEFAULT 'duffel',
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS idx_travel_obs_route ON travel_observations (route_key, observed_at DESC);
    CREATE TABLE IF NOT EXISTS travel_profile (
      user_sub VARCHAR(255) PRIMARY KEY,
      tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-00000000c002',
      display_name TEXT, home_airport VARCHAR(8), preferred_airlines TEXT[] NOT NULL DEFAULT '{}',
      preferred_cabin VARCHAR(16) NOT NULL DEFAULT 'economy', seat_pref VARCHAR(16),
      hotel_brands TEXT[] NOT NULL DEFAULT '{}', avoid TEXT[] NOT NULL DEFAULT '{}',
      budget_band VARCHAR(16), loyalty JSONB NOT NULL DEFAULT '{}'::jsonb, notes TEXT,
      onboarded BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS travel_searches (
      search_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_sub VARCHAR(255) NOT NULL,
      kind VARCHAR(8) NOT NULL DEFAULT 'flight', route_key VARCHAR(160) NOT NULL,
      query JSONB NOT NULL DEFAULT '{}'::jsonb, best_price NUMERIC(10,2), currency VARCHAR(8) DEFAULT 'USD',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS idx_travel_searches_user ON travel_searches (user_sub, created_at DESC);
    CREATE TABLE IF NOT EXISTS travel_watches (
      watch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_sub VARCHAR(255) NOT NULL,
      kind VARCHAR(8) NOT NULL DEFAULT 'flight', route_key VARCHAR(160) NOT NULL,
      query JSONB NOT NULL DEFAULT '{}'::jsonb, target_price NUMERIC(10,2), last_price NUMERIC(10,2),
      currency VARCHAR(8) DEFAULT 'USD', status VARCHAR(16) NOT NULL DEFAULT 'active',
      last_checked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS idx_travel_watches_active ON travel_watches (status) WHERE status = 'active';
    CREATE TABLE IF NOT EXISTS travel_conversations (
      conversation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_sub VARCHAR(255) NOT NULL,
      title TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS travel_messages (
      message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES travel_conversations(conversation_id) ON DELETE CASCADE,
      user_sub VARCHAR(255) NOT NULL, role VARCHAR(16) NOT NULL, content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS travel_feedback (
      feedback_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_sub VARCHAR(255) NOT NULL,
      note TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_travel_feedback_user_note ON travel_feedback (user_sub, lower(note));
  `],
    requirements: [
      { table: 'travel_observations', columns: ['obs_id', 'kind', 'route_key', 'origin', 'destination', 'depart_date', 'return_date', 'price', 'currency', 'source', 'observed_at'] },
      { table: 'travel_profile', columns: ['user_sub', 'tenant_id', 'display_name', 'home_airport', 'preferred_airlines', 'preferred_cabin', 'loyalty', 'onboarded', 'created_at', 'updated_at'] },
      { table: 'travel_searches', columns: ['search_id', 'user_sub', 'kind', 'route_key', 'query', 'best_price', 'currency', 'created_at'] },
      { table: 'travel_watches', columns: ['watch_id', 'user_sub', 'kind', 'route_key', 'query', 'target_price', 'status', 'created_at', 'updated_at'] },
      { table: 'travel_conversations', columns: ['conversation_id', 'user_sub', 'title', 'created_at', 'updated_at'] },
      { table: 'travel_messages', columns: ['message_id', 'conversation_id', 'user_sub', 'role', 'content', 'created_at'] },
      { table: 'travel_feedback', columns: ['feedback_id', 'user_sub', 'note', 'created_at'] },
    ],
  });
}

// ── Route keys + observations (the swarm price DB) ─────────────────────────────
/**
 * @description Canonical route key for a travel query — the aggregation key of the
 * swarm price DB (travel_observations), shared by the surface, the cron, and readers.
 * @param kind - 'flight' | 'hotel' | 'car'.
 * @param q - the search query (origin/destination/dates or city/dates).
 * @returns the normalized route key string.
 */
export function routeKeyFor(kind: string, q: any): string {
  if (kind === 'hotel') return `hotel:${(q.city || '').toUpperCase()}:${q.checkIn || ''}:${q.checkOut || ''}`;
  if (kind === 'car') return `car:${(q.city || '').toUpperCase()}:${q.pickupDate || ''}:${q.dropoffDate || ''}:${q.carClass || ''}`;
  return `flight:${(q.origin || '').toUpperCase()}-${(q.destination || '').toUpperCase()}:${q.departDate || ''}:${q.returnDate || 'ow'}:${q.cabin || 'economy'}`;
}

/**
 * @description Writes each quote into the swarm price DB — ANONYMIZED (no user_sub on
 * the row, ADR-059 §2). Failures degrade to a warn; a search never breaks on a write.
 * @param pool - Postgres pool.
 * @param kind - 'flight' | 'hotel' | 'car'.
 * @param q - the search query the quotes answer.
 * @param items - quote items (top 5 recorded).
 * @param source - quote source ('duffel' | 'demo').
 * @returns resolves when the writes have been attempted.
 */
export async function recordObservations(pool: Pool, kind: string, q: any, items: any[], source: string): Promise<void> {
  const routeKey = routeKeyFor(kind, q);
  const top = (items || []).slice(0, 5);
  for (const it of top) {
    const price = Number(it.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const carrier = it.airline || it.brand || it.name || null;
    await pool.query(
      `INSERT INTO travel_observations (kind, route_key, origin, destination, depart_date, return_date, cabin, carrier, price, currency, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        kind, routeKey, (q.origin || null), (q.destination || q.city || null),
        isoDate(q.departDate || q.checkIn || q.pickupDate), isoDate(q.returnDate || q.checkOut || q.dropoffDate),
        q.cabin || q.carClass || null, carrier, Number(price.toFixed(2)), it.currency || 'USD', source,
      ],
    ).catch((err) => logger.warn({ err }, 'observation write failed'));
  }
}
function isoDate(s: any): string | null {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * @description Reads the swarm price intelligence for a route: 90-day stats + an honest
 * verdict on the current best quote. Never judges on fewer than 5 samples.
 * @param pool - Postgres pool.
 * @param kind - 'flight' | 'hotel' | 'car' (informational; the key encodes it).
 * @param routeKey - the canonical route key (routeKeyFor).
 * @param currentBest - the best current quote, or null when there are no results.
 * @returns verdict/advice/stats over travel_observations.
 */
export async function priceRead(pool: Pool, kind: string, routeKey: string, currentBest: number | null): Promise<any> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n, MIN(price) AS min, MAX(price) AS max, AVG(price) AS avg,
            percentile_cont(0.25) WITHIN GROUP (ORDER BY price) AS p25
       FROM travel_observations
      WHERE route_key = $1 AND observed_at > NOW() - INTERVAL '90 days'`,
    [routeKey],
  );
  const s = r.rows[0] || {};
  const n = Number(s.n) || 0;
  const stats = {
    samples: n,
    min: s.min != null ? Number(Number(s.min).toFixed(2)) : null,
    avg: s.avg != null ? Number(Number(s.avg).toFixed(2)) : null,
    p25: s.p25 != null ? Number(Number(s.p25).toFixed(2)) : null,
  };
  let verdict = 'unknown';
  let advice = 'Not enough price history yet to judge — searching builds it for everyone.';
  if (n >= 5 && currentBest != null && stats.avg != null && stats.p25 != null) {
    if (currentBest <= stats.p25) { verdict = 'good'; advice = `Good price — at or below the cheapest quarter of recent quotes (avg $${stats.avg}). Reasonable to book.`; }
    else if (currentBest <= stats.avg) { verdict = 'typical'; advice = `Typical price — around the recent average ($${stats.avg}). Fine to book, or watch for a dip.`; }
    else { verdict = 'high'; advice = `On the high side — above the recent average ($${stats.avg}). Consider watching the route for a drop.`; }
  }
  return { verdict, advice, currentBest, ...stats };
}

/** Run the Duffel CLI for a given watcher with only its exact broker-resolved token. */
async function duffelCli(pool: Pool, sub: string, args: string[]): Promise<any> {
  const creds = await resolveServerOperationCreds(
    pool as unknown as never,
    sub,
    ['duffel'],
    'fixed-server-operation',
  );
  return new Promise((resolve) => {
    execFile(process.execPath, [path.resolve(process.cwd(), DUFFEL_CLI), ...args],
      {
        env: buildTravelFarewatchProcessEnv(sub, creds.OSHAL_CRED_DUFFEL),
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
      }, (_err, stdout) => {
        try { resolve(JSON.parse((stdout || '').trim() || '{}')); } catch { resolve({}); }
      });
  });
}

/** Re-price one watch: write observations, update last_price, flip to 'tripped' on a drop. */
async function checkWatch(ctx: AppContext, w: any): Promise<void> {
  const pool = ctx.pool;
  if (w.kind !== 'flight') { // hotels/cars are demo-only today — just stamp last_checked_at
    await pool.query(`UPDATE travel_watches SET last_checked_at = NOW(), updated_at = NOW() WHERE watch_id = $1`, [w.watch_id]);
    return;
  }
  const q = w.query || {};
  if (!q.origin || !q.destination || !q.departDate) return;
  const args = ['flights', q.origin, q.destination, q.departDate];
  if (q.returnDate) args.push(q.returnDate);
  args.push(String(q.pax || 1), q.cabin || 'economy');
  const r = await duffelCli(pool, w.user_sub, args);
  const items = r.items || [];
  if (!items.length) {
    await pool.query(`UPDATE travel_watches SET last_checked_at = NOW(), updated_at = NOW() WHERE watch_id = $1`, [w.watch_id]);
    return;
  }
  const best = Math.min(...items.map((i: any) => Number(i.price)));
  const routeKey = w.route_key || routeKeyFor('flight', q);

  // Grow the swarm price DB (anonymized — no user_sub).
  for (const it of items.slice(0, 5)) {
    const price = Number(it.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    await pool.query(
      `INSERT INTO travel_observations (kind, route_key, origin, destination, cabin, carrier, price, currency, source)
       VALUES ('flight',$1,$2,$3,$4,$5,$6,$7,$8)`,
      [routeKey, q.origin, q.destination, q.cabin || null, it.airline || null, Number(price.toFixed(2)), it.currency || 'USD', r.source || 'demo'],
    ).catch(() => {});
  }

  const target = w.target_price != null ? Number(w.target_price) : null;
  const prev = w.last_price != null ? Number(w.last_price) : null;
  const tripped = target != null ? best <= target : (prev != null ? best < prev : false);
  await pool.query(
    `UPDATE travel_watches SET last_price = $2, last_checked_at = NOW(), updated_at = NOW(),
       status = CASE WHEN $3 THEN 'tripped' ELSE status END WHERE watch_id = $1`,
    [w.watch_id, Number(best.toFixed(2)), tripped],
  );
  if (tripped) logger.info({ watchId: w.watch_id, routeKey, best, target }, 'fare watch tripped');
}

/** Re-price every active watch. */
async function checkAllWatches(ctx: AppContext): Promise<void> {
  const rows = (await ctx.pool.query(
    `SELECT * FROM travel_watches WHERE status = 'active' ORDER BY last_checked_at ASC NULLS FIRST LIMIT 200`,
  )).rows;
  for (const w of rows) {
    try { await checkWatch(ctx, w); }
    catch (err) { logger.warn({ err, watchId: w.watch_id }, 'fare watch check failed'); }
  }
  if (rows.length) logger.info({ checked: rows.length }, 'fare watches re-priced');
}

/**
 * @description Start the fare-watch cron: a first run shortly after boot, then every
 * TRAVEL_FAREWATCH_INTERVAL_MIN minutes (default 360 = every 6h). Configurable + idempotent.
 */
let cronStarted = false;

export function startTravelFareWatchCron(ctx: AppContext): void {
  // Double-start guard — the JSDoc always claimed idempotent; now it is (2026-07-05 leak audit).
  if (cronStarted) { logger.warn('fare-watch cron already started — ignoring duplicate start'); return; }
  cronStarted = true;
  // The store is swarm-shared and must exist even when the Travel surface package is not
  // installed (pre-carve, the createTravelRoutes mount ensured it at boot).
  ensureTravelSchema(ctx.pool).catch((err) => logger.warn({ err }, 'Travel schema bootstrap deferred — tables may not exist yet'));
  const mins = Math.max(parseInt(process.env.TRAVEL_FAREWATCH_INTERVAL_MIN || '360', 10), 30);
  const bootTimer = setTimeout(() => { runWithSystemIdentity(() => checkAllWatches(ctx)).catch((err) => logger.error({ err }, 'fare watch (boot) failed'));
  bootTimer.unref(); }, 180_000);
  const cronTimer = setInterval(() => { runWithSystemIdentity(() => checkAllWatches(ctx)).catch((err) => logger.error({ err }, 'fare watch (interval) failed'));
  cronTimer.unref(); }, mins * 60_000);
  logger.info({ intervalMin: mins }, 'Travel fare-watch cron started');
}
