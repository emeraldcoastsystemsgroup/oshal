/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep ticket isolation fixture on a canonical task store for protected result lookup.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Give the existing isolation fixture its authenticated synthetic issuer and active actor from that same request; preserve hostile-query ownership and foreign404 assertions.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Supply canonical creation-schema defaults to fixture inputs without changing ownership assertions.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { InMemoryTaskStore } from '@/entities/task';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTicketStore, TicketService } from '../../src/features/ticketing';
import { CreateInternalTicketSchema } from '@/entities/ticket';
import { createTicketRoutes } from '../../src/app/routes/ticket-routes';
import { getCaller } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';

const FIXTURE_ISSUER = 'https://ticket-isolation.fixture.test';
const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'false';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('ticket API isolation routes', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
    servers.length = 0;
  });

  it('does not let a non-operator list or read another user ticket', async () => {
    const ticketService = new TicketService(new InMemoryTicketStore());
    const userATicket = await ticketService.createTicket(CreateInternalTicketSchema.parse({
      title: 'User A ticket',
      description: 'owned by A',
      ticketType: 'task',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'auth0|user-a',
    }));
    const userBTicket = await ticketService.createTicket(CreateInternalTicketSchema.parse({
      title: 'User B ticket',
      description: 'owned by B',
      ticketType: 'task',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'auth0|user-b',
    }));

    const app = express();
    app.use(express.json());
    app.use(mockOidc('auth0|user-a'));
    app.use('/api/tickets', createTicketRoutes({
      ticketService,
      taskStore: new InMemoryTaskStore(),
      messageStore: {},
      orchestrator: {},
      pool: {},
      applicationAuthorization: { resolveActor: sessionActor },
    } as never));

    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const listResponse = await fetch(`${baseUrl}/api/tickets?scope=all&ownerSub=auth0%7Cuser-b`);
    const listBody = await listResponse.json() as { tickets: Array<{ ticketId: string }> };
    expect(listResponse.status).toBe(200);
    expect(listBody.tickets.map((ticket) => ticket.ticketId)).toEqual([userATicket.ticketId]);

    const directResponse = await fetch(`${baseUrl}/api/tickets/${encodeURIComponent(userBTicket.ticketId)}`);
    expect(directResponse.status).toBe(404);
  });
});

/**
 * @description Resolves the active synthetic actor from the same authenticated fixture request.
 * @param req - The request populated by mockOidc.
 * @returns The fixture session actor; never an identity from query or body.
 */
async function sessionActor(req: Request): Promise<{ sub: string; issuer: string; isActive: boolean; isSwarmAdmin: boolean }> {
  const sub = getCaller(req).sub;
  const issuer = getAuthenticatedPrincipalIssuer(req);
  if (!sub || !issuer) throw new Error('fixture_identity_required');
  return { sub, issuer, isActive: true, isSwarmAdmin: false };
}

/** @description Supplies one authenticated synthetic OIDC session to the isolated router fixture. */
function mockOidc(sub: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as { oidc?: unknown }).oidc = {
      isAuthenticated: () => true,
      user: { sub, iss: FIXTURE_ISSUER, email: `${sub.replace(/[^a-z0-9]/gi, '-')}@example.test` },
    };
    next();
  };
}
