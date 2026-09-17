/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the long-lived bot-node's Postgres pool no longer becomes null for life when the cold-start race is lost. Measured 2026-09-17: a Docker daemon bounce cold-started every bot beside a cold Postgres, connectPool gave up after 10 attempts x 2 s, ended the pool and returned null, and 28 of 36 bots then served /health 200 without a database until a human restarted them. Here the SAME pool object is kept and handed to the boot path whether or not the first window succeeded (pg connects per checkout, so a pool that failed at second 20 works at second 40), a background probe with capped exponential backoff latches readiness on the first success and resolves whenReady so boot-only database steps can run late, and the status it exposes is what the health route and the refusal code read. One-shot callers (batch, record-cost, finalize-incident) keep connectPool's bounded null-on-exhaustion contract - a Job pod must exit, not wait.
 */
import { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { gucEnabled, wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { postgresApplicationName, resolvePoolMax } from '@/shared/services/database/pool-sizing';

const logger = createChildLogger({ module: 'bot-node-database-pool' });

/** The refusal code a bot answers with when the cause is "no usable database", not a policy decision. */
export const DATABASE_POOL_UNAVAILABLE = 'database_pool_unavailable';

/** What the health route and operators need to know about this process's database. */
export interface BotNodeDatabaseStatus {
  /** DATABASE_URL is set, so this process is SUPPOSED to have a database. */
  configured: boolean;
  /** A probe query has succeeded at least once on the pool the boot path was given. */
  ready: boolean;
  /** Probe attempts made so far (boot window + background recovery). */
  attempts: number;
  /** Message of the most recent failed probe; never a connection string. */
  lastError?: string;
}

/** A pool that exists from boot, plus the truth about whether it has ever answered. */
export interface BotNodeDatabase {
  /** Null ONLY when DATABASE_URL is unset (deliberate DB-less run). Never nulled by a lost race. */
  pool: Pool | null;
  /** Live status snapshot. */
  status: () => BotNodeDatabaseStatus;
  /** Resolves on the first successful probe - immediately when boot connected. Never rejects. */
  whenReady: Promise<void>;
  /** Cancels background recovery (shutdown and tests). */
  stop: () => void;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function newBotPool(dbUrl: string): Pool {
  return new Pool({
    connectionString: dbUrl,
    max: resolvePoolMax(process.env.DB_MAX_CONNECTIONS, 5),
    application_name: postgresApplicationName(
      process.env.PGAPPNAME,
      `oshal-bot-${process.env.BOT_NAME || process.env.AGENT_ID || 'unknown'}`,
    ),
  });
}

/**
 * @description Bounded connect for ONE-SHOT callers (batch Job pod, record-cost, finalize-incident):
 * retries a cold start, then gives up and returns null so the process can exit. The long-lived
 * server must NOT use this - see {@link connectRecoverableBotNodeDatabase}.
 * @returns The GUC-wrapped pool, or null when DATABASE_URL is unset or the window was exhausted.
 */
export async function connectPool(): Promise<Pool | null> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  const raw = newBotPool(dbUrl);
  const maxAttempts = Math.max(1, positiveNumber(process.env.BOT_DB_CONNECT_ATTEMPTS, 10));
  const retryMs = positiveNumber(process.env.BOT_DB_CONNECT_RETRY_MS, 2000);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await raw.query('SELECT 1');
      logger.info('Postgres connected');
      return gucEnabled() ? wrapPoolWithGuc(raw) : raw;
    } catch (err) {
      if (attempt === maxAttempts) {
        logger.warn({ err, attempts: maxAttempts }, 'Postgres not available after retries - one-shot caller continues without DB');
        try { await raw.end(); } catch (endErr) { logger.error({ err: endErr }, 'Failed pool cleanup errored'); }
        return null;
      }
      logger.info({ attempt, maxAttempts }, 'Postgres not ready - retrying');
      await delay(retryMs);
    }
  }
  return null;
}

/**
 * @description Connect for the LONG-LIVED bot-node. Runs the same bounded boot window so a warm
 * database still yields a ready pool before the server listens; on exhaustion it KEEPS the pool,
 * returns it to the boot path unchanged, and keeps probing in the background with capped
 * exponential backoff until the first success. Because every repository and guard was constructed
 * over this same object, the first success is installed everywhere at once.
 * @returns The database handle; `pool` is null only when DATABASE_URL is unset.
 */
export async function connectRecoverableBotNodeDatabase(): Promise<BotNodeDatabase> {
  const dbUrl = process.env.DATABASE_URL;
  const state: BotNodeDatabaseStatus = { configured: Boolean(dbUrl), ready: false, attempts: 0 };
  const status = (): BotNodeDatabaseStatus => ({ ...state });
  if (!dbUrl) return { pool: null, status, whenReady: new Promise<void>(() => undefined), stop: () => undefined };

  const raw = newBotPool(dbUrl);
  // An idle-client error with no listener is an uncaught exception; a recovering pool expects them.
  raw.on('error', (err) => logger.error({ err }, 'Postgres idle client error'));
  const pool = gucEnabled() ? wrapPoolWithGuc(raw) : raw;
  const probe = (): Promise<boolean> => probeOnce(raw, state);

  const maxAttempts = Math.max(1, positiveNumber(process.env.BOT_DB_CONNECT_ATTEMPTS, 10));
  const retryMs = positiveNumber(process.env.BOT_DB_CONNECT_RETRY_MS, 2000);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await probe()) {
      logger.info({ attempts: state.attempts }, 'Postgres connected');
      return { pool, status, whenReady: Promise.resolve(), stop: () => undefined };
    }
    if (attempt < maxAttempts) {
      logger.info({ attempt, maxAttempts }, 'Postgres not ready - retrying');
      await delay(retryMs);
    }
  }

  logger.error({ attempts: state.attempts, lastError: state.lastError },
    'Postgres not available in the boot window - serving UNHEALTHY and recovering in the background');
  const control = { stopped: false };
  // Resolves ONLY on success: a stopped recovery must not fire the late boot steps without a database.
  const whenReady = new Promise<void>((resolve) => {
    void recoverInBackground(probe, state, control, retryMs).then((connected) => { if (connected) resolve(); });
  });
  return { pool, status, whenReady, stop: () => { control.stopped = true; } };
}

async function probeOnce(raw: Pool, state: BotNodeDatabaseStatus): Promise<boolean> {
  state.attempts += 1;
  try {
    await raw.query('SELECT 1');
    state.ready = true;
    delete state.lastError;
    return true;
  } catch (err) {
    state.lastError = err instanceof Error ? (err.message || err.name) : 'unknown error';
    return false;
  }
}

async function recoverInBackground(probe: () => Promise<boolean>, state: BotNodeDatabaseStatus,
  control: { stopped: boolean }, firstDelayMs: number): Promise<boolean> {
  const maxDelayMs = positiveNumber(process.env.BOT_DB_RECOVERY_MAX_DELAY_MS, 30_000);
  let waitMs = firstDelayMs;
  while (!control.stopped) {
    await delay(waitMs);
    if (control.stopped) return false;
    if (await probe()) {
      logger.info({ attempts: state.attempts }, 'Postgres connected after background recovery - pool is live');
      return true;
    }
    waitMs = Math.min(waitMs * 2, maxDelayMs);
    logger.warn({ attempts: state.attempts, lastError: state.lastError, nextRetryMs: waitMs },
      'Postgres still unavailable - background recovery continues');
  }
  return false;
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE']);
const SERVER_UNAVAILABLE_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300']);
const CONNECT_MESSAGES = ['timeout exceeded when trying to connect', 'Connection terminated', 'connection timeout'];

/**
 * @description Tells "the database could not be reached" apart from "the database answered with an
 * error". Only the first is a pool outage; a 42501 or a missing helper is a posture fault and keeps
 * its authorization code.
 * @param err - Whatever a pool query rejected with.
 * @returns True for socket/DNS failures, SQLSTATE class 08, server start-up/shutdown and connect timeouts.
 */
export function isDatabaseUnavailableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { code, message, errors, cause } = err as { code?: unknown; message?: unknown; errors?: unknown; cause?: unknown };
  if (typeof code === 'string' && (NETWORK_CODES.has(code) || code.startsWith('08') || SERVER_UNAVAILABLE_SQLSTATES.has(code))) return true;
  if (typeof message === 'string' && CONNECT_MESSAGES.some((text) => message.includes(text))) return true;
  if (Array.isArray(errors) && errors.some(isDatabaseUnavailableError)) return true;
  return cause !== undefined && cause !== err && isDatabaseUnavailableError(cause);
}
