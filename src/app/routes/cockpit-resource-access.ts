/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Share current owner, issuer and protected-result checks between project discovery and ticket streams.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ownsRow/actorFor moved unchanged to record-ownership.ts (ownsRecord/verifiedActorFor). canReadCockpitTicket now delegates to canReadTicket, the /api/tickets verdict built on the same ownsRecord, so the cockpit and the ticket API read a ticket by one rule. Cockpit verdicts are unchanged. P5 step 1.
 */
import type { Request } from 'express';
import type { InternalTicket } from '@/entities/ticket';
import type { StoredTask } from '@/shared/types';
import { canReadProtectedResult, type ProtectedResultTask } from '@/shared/protected-results';
import type { AppContext } from '../composition-root';
import { ownsRecord, verifiedActorFor } from './record-ownership';
import { canReadTicket } from './ticket-application-access';

/** @description Admit ticket metadata only with current owner and application rights: the one ticket verdict. @param ctx Runtime. @param req Request. @param ticket Stored ticket. @returns Read admission. */
export async function canReadCockpitTicket(ctx: AppContext, req: Request, ticket: InternalTicket): Promise<boolean> {
  return canReadTicket(ctx, req, ticket);
}

/** @description Admit task metadata only with current owner and application rights. @param ctx Runtime. @param req Request. @param task Stored task. @returns Read admission. */
export async function canReadCockpitTask(ctx: AppContext, req: Request, task: StoredTask): Promise<boolean> {
  return canReadCockpitResult(ctx, req, task);
}

/** @description Constrain correlated work-item output using its canonical owner and current result lineage. @param ctx Runtime. @param req Caller. @param task Bound result source. @returns Read admission. */
export async function canReadCockpitResult(ctx: AppContext, req: Request, task: ProtectedResultTask): Promise<boolean> {
  try { return await ownsRecord(ctx, req, task) && await canReadProtectedResult(task, () => verifiedActorFor(ctx, req)); }
  catch { return false; }
}
