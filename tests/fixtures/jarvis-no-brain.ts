/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The REAL Jarvis router behind a synthetic identity rail and an in-memory context, for the no-hosted-brain honesty guards. Persistence and the caller's identity are doubles; the router, runJarvisBot, the executeBotOrInline chokepoint, stampRemoteBrain and the swarm bot registry are not. The user-brain ladder is doubled by the spec that uses this (vi.mock is per spec file), so "the caller has no endpoint anywhere" stays that spec's visible precondition.
 */
import express, { type RequestHandler, type Router } from 'express';
import { InMemoryMessageStore } from '../../src/entities/message';
import { InMemoryTaskStore } from '../../src/entities/task';
import { createJarvisRoutes } from '../../src/app/routes/jarvis-routes';

/** The signed-in caller every no-brain case runs as — an ordinary user sub, never a deployment operator. */
export const NO_BRAIN_SUB = 'auth0|no-brain-operator';

/** The one read the work-queue/briefing shelf makes against `jarvis_tasks`. */
const SHELF_READ = /FROM jarvis_tasks WHERE user_sub = \$1 ORDER BY created_at/;

/** One stored work-queue row, in the column shape GET /api/jarvis/tasks selects. */
export type ShelfRow = Record<string, unknown>;

/**
 * @description A finished shelf row of the kind a morning briefing leaves behind. It needs no live
 * model to list, which is the property the shelf guard pins.
 * @param overrides - Columns to change for one case.
 * @returns A `jarvis_tasks` row owned by {@link NO_BRAIN_SUB}.
 */
export function noBrainShelfRow(overrides: ShelfRow = {}): ShelfRow {
  return {
    id: '5f6c2b40-0000-4000-8000-0000000000aa', user_sub: NO_BRAIN_SUB, session_id: null,
    briefing_source_id: null, principal_issuer: null, title: 'Your morning briefing', status: 'done',
    result: 'Three things worth your attention this morning.', error: null, kind: 'simple', ticket_id: null,
    visual: null, files: null, delivered: false,
    created_at: new Date('2026-09-14T11:00:00Z'), finished_at: new Date('2026-09-14T11:00:04Z'),
    ...overrides,
  };
}

/**
 * @description Build the shipped Jarvis router for the no-brain cases. Every statement answers empty
 * except the shelf read, which returns `shelfRows`, so the ask path and the shelf run against the
 * same caller in the same state.
 * @param shelfRows - Rows the shelf read returns; empty by default.
 * @returns An express router (identity rail + the real Jarvis routes) to mount at `/api/jarvis`.
 */
export function createNoBrainJarvisRouter(shelfRows: ShelfRow[] = []): Router {
  const ctx = {
    pool: {
      query: async (text: string) => (SHELF_READ.test(String(text))
        ? { rows: shelfRows, rowCount: shelfRows.length }
        : { rows: [], rowCount: 0 }),
    },
    taskStore: new InMemoryTaskStore(),
    messageStore: new InMemoryMessageStore(),
    ticketService: {
      listTickets: async () => [],
      openChatTicket: async () => ({ ticketId: 'no-brain-chat' }),
      createTicket: async () => ({ ticketId: 'no-brain-ticket' }),
      updateStatus: async () => undefined,
    },
  };
  const identity: RequestHandler = (request, _response, next) => {
    (request as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub: NO_BRAIN_SUB } };
    next();
  };
  const router = express.Router();
  router.use(identity, createJarvisRoutes(ctx as never, process.cwd()));
  return router;
}
