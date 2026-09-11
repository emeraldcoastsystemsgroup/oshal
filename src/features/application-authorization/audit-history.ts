/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Scope and redact applied-change history with actor-bound revision-snapshot cursors.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep reserved global membership events outside delegated application history.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createChildLogger } from '@/shared/logger';
import type { AuthorizationActor, AuthorizationAuditInput, AuthorizationAuditPage, AuthorizationAuditEntry } from '@/shared/application-authorization';
import { EXTERNAL_TENANT_MEMBERSHIP_AUDIT_APP } from '@/shared/application-authorization';
import { AuthorizationAuditSchema } from '@/shared/security/authorization-tool-contract';
import { managementAllowed } from './policy';
import { ApplicationAuthorizationError, type AuthorizationAudit, type AuthorizationStore } from './types';
const logger = createChildLogger({ module: 'authorization-audit-history' });

const cursorSchema = z.object({ version: z.literal(1), scope: z.string().length(64), snapshotRevision: z.number().int().nonnegative().safe(),
  before: z.object({ revision: z.number().int().positive().safe(), id: z.string().uuid() }).strict(),
}).strict().refine(cursor => cursor.before.revision <= cursor.snapshotRevision);
const reject = () => new ApplicationAuthorizationError(400, 'invalid_authorization_audit_query');

/** @description Read applied changes after service-level actor refresh; projection and filters cannot expand authority.
 * @param store Shared durable policy store. @param actor Currently verified actor. @param raw Untrusted bounded filters.
 * @returns Redacted page in descending revision/ID order and a stable continuation, when available.
 */
export async function readAuthorizationAudit(store: AuthorizationStore, actor: AuthorizationActor, raw: AuthorizationAuditInput): Promise<AuthorizationAuditPage> {
  const parsed = AuthorizationAuditSchema.safeParse(raw);
  if (!parsed.success) throw reject();
  const input = parsed.data;
  if ((!input.app && !actor.isSwarmAdmin) || (input.app === EXTERNAL_TENANT_MEMBERSHIP_AUDIT_APP && !actor.isSwarmAdmin)
    || !managementAllowed(actor, input.app ?? '', input.tenantId, 'read')) {
    throw new ApplicationAuthorizationError(403, 'authorization_management_denied');
  }
  const scope = createHash('sha256').update(JSON.stringify([actor.issuer, actor.sub, input.app ?? null, input.tenantId ?? null])).digest('hex');
  const cursor = decodeCursor(input.cursor, scope);
  const limit = input.limit ?? 25;
  const result = await store.readAudit({ app: input.app, tenantId: input.tenantId, limit: limit + 1,
    snapshotRevision: cursor?.snapshotRevision, before: cursor?.before });
  const events = result.events.slice(0, limit); const last = events.at(-1);
  const nextCursor = result.events.length > limit && last ? Buffer.from(JSON.stringify({ version: 1, scope,
    snapshotRevision: result.snapshotRevision, before: { revision: last.revision, id: last.id } })).toString('base64url') : null;
  return { entries: events.map(projectAudit), snapshotRevision: result.snapshotRevision, nextCursor };
}

function decodeCursor(value: string | undefined, scope: string) {
  if (!value) return null;
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (parsed.scope !== scope) throw reject();
    return parsed;
  } catch (error) { logger.error({ err: error }, 'Authorization audit cursor refused'); throw reject(); }
}

function projectAudit(event: AuthorizationAudit): AuthorizationAuditEntry {
  const change = event.change;
  return { id: event.id, revision: event.revision, at: event.at, actor: { sub: event.actor.sub, issuer: event.actor.issuer },
    app: change.app, action: change.action, tenantId: change.tenantId, targetSub: change.targetSub, targetIssuer: change.targetIssuer,
    group: change.group ? { issuer: change.group.issuer, tenantId: change.group.tenantId, id: change.group.id } : undefined,
    role: change.role, permission: change.permission };
}
