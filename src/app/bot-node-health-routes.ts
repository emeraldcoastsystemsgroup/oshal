/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the bot-node health probes, extracted from bot-node-server.ts and made database-aware. `/health` answered a literal {status:'ok'} whatever the process could do, so on 2026-09-17 28 pool-less bots all reported healthy to Docker (Dockerfile.oshal HEALTHCHECK is `curl -f http://localhost:5000/health`) and to a wrap-up that counted "42/42 healthy". When DATABASE_URL is configured and the pool has never answered, both probes now return 503 so `curl -f` fails and `docker ps` says unhealthy. A deliberately DB-less run (no DATABASE_URL) stays 200. The public body carries counts and the cause code only - never the driver's error text, which can name hosts.
 */
import type { Express } from 'express';
import { DATABASE_POOL_UNAVAILABLE, type BotNodeDatabaseStatus } from './bot-node-database-pool';

/** What the probes need; identity/provider fields are reported on `/api/health` only. */
export interface BotNodeHealthDeps {
  databaseStatus: () => BotNodeDatabaseStatus;
  describe: () => Record<string, unknown>;
}

/** The verdict one probe call reports. */
export interface BotNodeHealthVerdict {
  httpStatus: 200 | 503;
  body: { status: 'ok' | 'unhealthy'; reason?: string; database: { configured: boolean; ready: boolean; attempts: number } };
}

/**
 * @description Decides the probe answer from the database status alone, so the rule has one
 * definition: a configured database that has never answered is unhealthy.
 * @param status - Live status from the runtime's database handle.
 * @returns HTTP status and public body.
 */
export function botNodeHealthVerdict(status: BotNodeDatabaseStatus): BotNodeHealthVerdict {
  const database = { configured: status.configured, ready: status.ready, attempts: status.attempts };
  if (status.configured && !status.ready) {
    return { httpStatus: 503, body: { status: 'unhealthy', reason: DATABASE_POOL_UNAVAILABLE, database } };
  }
  return { httpStatus: 200, body: { status: 'ok', database } };
}

/**
 * @description Mounts `GET /health` (the container HEALTHCHECK target) and `GET /api/health`.
 * Both are public probes by design (see authorizeBotNodeBeforeBody) and both share one verdict.
 * @param app - The bot-node Express app.
 * @param deps - Live database status and the identity/provider description for `/api/health`.
 * @returns Nothing.
 */
export function registerBotNodeHealthRoutes(app: Express, deps: BotNodeHealthDeps): void {
  app.get('/health', (_req, res) => {
    const verdict = botNodeHealthVerdict(deps.databaseStatus());
    res.status(verdict.httpStatus).json(verdict.body);
  });
  app.get('/api/health', (_req, res) => {
    const verdict = botNodeHealthVerdict(deps.databaseStatus());
    res.status(verdict.httpStatus).json({ ...verdict.body, ...deps.describe(), timestamp: new Date().toISOString() });
  });
}
