/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard trusted ticket-owner issuer stamping, spoof stripping, system inheritance, and legacy absence.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  OWNER_PRINCIPAL_ISSUER_METADATA_KEY,
  bindOwnerPrincipalIssuer,
  readOwnerPrincipalIssuer,
} from '@/shared/security/owner-principal-issuer';
import {
  runWithRequestIdentity,
  runWithSystemIdentity,
} from '@/shared/services/database/request-identity';
import { TicketService } from '@/features/ticketing';
import type { ITicketStore } from '@/entities/ticket';

const OWNER = 'oidc|owner';
const ISSUER = 'https://identity.example.test/realms/main';

describe('ticket owner principal issuer provenance', () => {
  it('uses verified request identity and overwrites a forged metadata value', () => {
    const metadata = runWithRequestIdentity(
      { sub: OWNER, principalIssuer: ISSUER, isOperator: false },
      () => bindOwnerPrincipalIssuer({
        visible: true,
        [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://forged.example.test',
      }, OWNER),
    );
    expect(metadata).toEqual({
      visible: true,
      [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: ISSUER,
    });
  });

  it('strips a supplied issuer when the request identity does not own the ticket', () => {
    const metadata = runWithRequestIdentity(
      { sub: 'oidc|other', principalIssuer: ISSUER, isOperator: false },
      () => bindOwnerPrincipalIssuer({
        [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://forged.example.test',
      }, OWNER),
    );
    expect(metadata).toEqual({});
  });

  it('allows only the positive system sentinel to preserve trusted persisted provenance', () => {
    const inherited = runWithSystemIdentity(() => bindOwnerPrincipalIssuer({
      [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: ISSUER,
    }, OWNER));
    const absent = runWithSystemIdentity(() => bindOwnerPrincipalIssuer({}, OWNER));
    expect(readOwnerPrincipalIssuer(inherited)).toBe(ISSUER);
    expect(readOwnerPrincipalIssuer(absent)).toBeNull();
  });

  it('treats malformed or legacy metadata as issuer-less', () => {
    expect(readOwnerPrincipalIssuer({ [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: '' })).toBeNull();
    expect(readOwnerPrincipalIssuer(undefined)).toBeNull();
  });

  it('wires the trusted provenance through TicketService creation', async () => {
    const create = vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      ticketId: '11111111-1111-4111-8111-111111111111',
      ticketType: input.ticketType ?? 'build',
      description: input.description ?? '',
      stateGroup: 'backlog',
      executionPhase: null,
      priority: input.priority ?? 'none',
      labels: input.labels ?? [],
      workspaceId: null,
      assignedAgentId: null,
      parentTicketId: null,
      externalProvider: null,
      externalId: null,
      externalUrl: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    }));
    const service = new TicketService({ create } as unknown as ITicketStore);
    await runWithRequestIdentity(
      { sub: OWNER, principalIssuer: ISSUER, isOperator: false },
      () => service.createTicket({
        title: 'issuer-bound ticket',
        ownerSub: OWNER,
        metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://forged.example.test' },
      }),
    );
    expect(create.mock.calls[0][0].metadata).toMatchObject({
      [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: ISSUER,
    });
  });
});
