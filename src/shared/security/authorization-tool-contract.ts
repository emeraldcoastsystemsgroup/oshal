/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Define the closed core authorization tool family and trusted invocation port.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add bounded, redacted applied authorization history under current application and tenant authority.
 */
import { z } from 'zod';
import type { AuthorizationActor } from '@/shared/application-authorization';

/** Code-owned names cannot be contributed or replaced by a package. */
export const AUTHORIZATION_TOOL = 'swarm_authorization';
/** AUTO transport supports only non-mutating access inspection. */
export const AUTHORIZATION_READ_TOOL = 'swarm_authorization_read';
/** @description Identify the reserved family. @param name Registry name. @returns Whether core owns it. */
export function isAuthorizationTool(name: string): boolean {
  return name === AUTHORIZATION_TOOL || name === AUTHORIZATION_READ_TOOL;
}

const identifier = z.string().min(1).max(512).refine((s) => !/[\x00-\x1f\x7f]/.test(s));
const app = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/);
/** Strict target schema shared by the tool and management routes; target is never the acting caller. */
export const AuthorizationTargetSchema = z.object({
  app, targetSub: identifier.optional(), targetIssuer: identifier.optional(), tenantId: identifier.optional(),
}).strict();
/** Strict explanation input contains references, never caller identity or resource attributes. */
export const AuthorizationExplainSchema = AuthorizationTargetSchema.extend({
  permission: identifier.optional(), kind: z.enum(['http', 'tools', 'bots', 'jobs', 'artifactActions']).optional(),
  operation: identifier.optional(), method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).optional(),
  path: identifier.optional(), resourceId: identifier.optional(), fields: z.array(identifier).max(128).optional(),
}).strict();
/** Changes use a closed action set and bind the currently observed revision. */
export const AuthorizationChangeSchema = AuthorizationTargetSchema.extend({
  action: z.enum(['grant', 'revoke', 'deny', 'clear-deny', 'group-map', 'group-unmap']),
  role: identifier.optional(), permission: identifier.optional(), expiresAt: z.string().datetime({ offset: true }).optional(),
  reason: z.string().trim().min(1).max(2000), expectedRevision: z.number().int().nonnegative().safe(),
  group: z.object({ issuer: identifier, tenantId: identifier, id: identifier }).strict().optional(),
}).strict();
/** Only a stored preview and server-verifiable approval reference can be applied. */
export const AuthorizationApplySchema = z.object({
  previewId: identifier, idempotencyKey: identifier, approvalReference: identifier.optional(),
}).strict();
/** Bounded read-only history; authority always comes from the server actor, never these filters. */
export const AuthorizationAuditSchema = z.object({ app: app.optional(), tenantId: identifier.optional(),
  limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict().refine(input => !input.tenantId || Boolean(input.app));
/** Runtime validation is independent of model-visible schema metadata. */
export const AuthorizationToolInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('catalog') }).strict(),
  z.object({ operation: z.literal('audit_history'), query: AuthorizationAuditSchema }).strict(),
  z.object({ operation: z.literal('effective'), target: AuthorizationTargetSchema }).strict(),
  z.object({ operation: z.literal('explain'), request: AuthorizationExplainSchema }).strict(),
  z.object({ operation: z.literal('preview_change'), change: AuthorizationChangeSchema }).strict(),
  z.object({ operation: z.literal('apply_change'), preview: AuthorizationApplySchema }).strict(),
]);
export type AuthorizationToolOperation = z.infer<typeof AuthorizationToolInputSchema>['operation'];
/** Constructed by authenticated server code, never parsed from tool input. Resolve fresh on every invocation. */
export interface AuthorizationToolInvocation {
  resolveActor: () => Promise<AuthorizationActor>;
  /** Only a trusted interactive, CSRF-protected user action may enable preview/apply. */
  allowChanges: boolean;
}
/** Fixed typed port: no shell, method/header overrides, arbitrary URL or asserted acting user. */
export interface AuthorizationToolExecutor {
  execute(name: string, input: unknown, invocation?: AuthorizationToolInvocation): Promise<string>;
}
/** Caller-scoped discovery result; the handler always checks current rights again. */
export interface AuthorizationToolDiscovery {
  name: typeof AUTHORIZATION_TOOL | typeof AUTHORIZATION_READ_TOOL;
  operations: AuthorizationToolOperation[];
  targets: Array<{ app: string; source: string; catalogRevision: string; operations: AuthorizationToolOperation[]; tenantIds?: string[] }>;
}
