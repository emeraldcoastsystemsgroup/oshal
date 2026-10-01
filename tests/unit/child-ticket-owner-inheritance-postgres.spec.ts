/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for children of a planned root belonging to the root's owner. Runs the real createChildTicketsFromPlanningOutput through the real TicketService and PostgresTicketStore on a least-privilege role, against a private Postgres with the shipped ticket migrations and FORCE row-level security. Proves each child carries the owner, the root's verified issuer and its planning order; the owner can read the children and another subject cannot; an ownerless root still yields ownerless children with no issuer.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { CreateInternalTicketSchema } from '../../src/entities/ticket';
import { PostgresTicketStore, TicketService } from '../../src/features/ticketing';
import { createChildTicketsFromPlanningOutput } from '../../src/features/swarm-orchestration/services/queue-manager-dispatch-helpers';
import { ensureTicketSchema } from '../../src/shared/services/database';
import { wrapPoolWithGuc } from '../../src/shared/services/database/guc-pool';
import { runWithRequestIdentity, runWithSystemIdentity } from '../../src/shared/services/database/request-identity';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '../../src/shared/security/owner-principal-issuer';

const RUNTIME_ROLE = 'child_owner_runtime';
const OWNER = 'child-owner-sub';
const OTHER = 'child-other-sub';
const ISSUER = 'https://issuer.fixture.invalid';

const UNITS = [
  { title: 'Build the CSV parser module', description: 'Parse rows.', acceptanceCriteria: ['Parses rows'], workType: 'implementation', labels: [] },
  { title: 'Build the schema validator module', description: 'Validate rows.', acceptanceCriteria: ['Validates rows'], workType: 'implementation', labels: [] },
];

const database = new DisposablePostgres({
  purpose: 'child-owner-inheritance',
  roles: [RUNTIME_ROLE],
  migrations: ['001-multi-agent-foundation.sql', '005-conversation-history-and-usage.sql', '100-ticket-family-base-schema.sql'],
});

let adminPool: Pool;
let ticketService: TicketService;

/**
 * @description Creates a root ticket the way an authenticated owner files one: under that owner's
 * request identity, so the issuer is stamped from the verified identity, not from the body.
 * @param ownerSub - The filing owner, or null for a system-filed ownerless root.
 * @returns The root ticket.
 */
async function fileRoot(ownerSub: string | null) {
  const create = () => ticketService.createTicket(CreateInternalTicketSchema.parse({
    title: 'Build a two-module CLI', ticketType: 'build', description: 'Two modules.',
    status: 'approved', priority: 'low', labels: [], ownerSub,
  }));
  return ownerSub
    ? runWithRequestIdentity({ sub: ownerSub, principalIssuer: ISSUER, isOperator: false }, create)
    : runWithSystemIdentity(create);
}

/** Children as the queue manager creates them: under the trusted SYSTEM identity. */
function createChildren(root: Awaited<ReturnType<typeof fileRoot>>) {
  return runWithSystemIdentity(() => createChildTicketsFromPlanningOutput(root, UNITS, undefined, { ticketService }));
}

beforeAll(async () => {
  adminPool = await database.start();
  await ensureTicketSchema(adminPool);
  await adminPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE}`);
  await adminPool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE}`);
  const runtimePool = wrapPoolWithGuc(database.rolePool(RUNTIME_ROLE));
  ticketService = new TicketService(runWithSystemIdentity(() => new PostgresTicketStore(runtimePool)));
}, 240_000);

afterAll(async () => { await database.stop(); }, 120_000);

describe('children of a planned root belong to the root owner (real store, FORCE row-level security)', () => {
  it('the fixture enforces: the tickets table forces row-level security and the runtime role is not a superuser', async () => {
    const forced = await adminPool.query("SELECT relforcerowsecurity FROM pg_class WHERE relname = 'tickets'");
    expect(forced.rows[0]?.relforcerowsecurity).toBe(true);
    const role = await adminPool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [RUNTIME_ROLE]);
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('each child carries the owner, the root verified issuer and its planning order', async () => {
    const root = await fileRoot(OWNER);
    expect(root.metadata?.[OWNER_PRINCIPAL_ISSUER_METADATA_KEY]).toBe(ISSUER);
    const { childTicketIds } = await createChildren(root);
    expect(childTicketIds).toHaveLength(2);

    const rows = await adminPool.query(
      'SELECT ticket_id, owner_sub, parent_ticket_id, metadata FROM tickets WHERE parent_ticket_id = $1',
      [root.ticketId],
    );
    const byIndex = new Map(rows.rows.map((row) => [row.metadata.subtaskIndex, row]));
    expect([...byIndex.keys()].sort()).toEqual([1, 2]);
    for (const [index, row] of byIndex) {
      expect(row.owner_sub).toBe(OWNER);
      expect(row.metadata[OWNER_PRINCIPAL_ISSUER_METADATA_KEY]).toBe(ISSUER);
      expect(row.metadata.subtaskCount).toBe(2);
      expect(row.metadata.subtaskTitle).toBe(UNITS[index - 1].title);
      expect(row.metadata.siblingTitles).toEqual([UNITS[2 - index].title]);
    }
  }, 60_000);

  it('the owner reads and lists the children; another subject sees none of them', async () => {
    const root = await fileRoot(OWNER);
    const { childTicketIds } = await createChildren(root);

    const asOwner = await runWithRequestIdentity({ sub: OWNER, principalIssuer: ISSUER, isOperator: false },
      () => Promise.all(childTicketIds.map((id) => ticketService.getTicket(id))));
    expect(asOwner.every((ticket) => ticket?.ownerSub === OWNER)).toBe(true);

    const asOther = await runWithRequestIdentity({ sub: OTHER, principalIssuer: ISSUER, isOperator: false },
      () => Promise.all(childTicketIds.map((id) => ticketService.getTicket(id))));
    expect(asOther).toEqual([null, null]);
  }, 60_000);

  it('an ownerless root yields ownerless children that carry no issuer', async () => {
    const root = await fileRoot(null);
    const { childTicketIds } = await createChildren(root);
    const rows = await adminPool.query('SELECT owner_sub, metadata FROM tickets WHERE ticket_id = ANY($1::uuid[])', [childTicketIds]);

    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.owner_sub).toBeNull();
      expect(row.metadata[OWNER_PRINCIPAL_ISSUER_METADATA_KEY]).toBeUndefined();
    }
  }, 60_000);
});
