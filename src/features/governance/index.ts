/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Created the governance feature barrel (FSD deep-import burn-down): surfaces the audit capture/emit API, the RBAC policy middleware + role/permission model, and the DLP egress redactor that consumers were reaching via deep paths.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Surface the swarm-role grant-source resolver so routes can name WHICH axis granted a role instead of deep-importing the RBAC internals.
 */

/**
 * @description Public surface for the governance feature slice — audit trail,
 * RBAC policy enforcement, and DLP egress redaction. Import these through the
 * slice barrel rather than the deep module paths.
 */

export {
  emitAuditEvent,
  queryAuditEvents,
  summarizeAuditActivity,
  type AuditQueryFilter,
  type AuditRow,
  type AuditDecision,
} from './audit/audit-emit';
export { createAuditCaptureMiddleware } from './audit/audit-capture-middleware';
export {
  rbacMiddleware,
  resolveRole,
  callerFromRequest,
  isEnforcementEnabled,
  requireAdminConsoleAccess,
  onBreakGlassAllowlist,
  type RbacCaller,
} from './rbac/policy';
export { resolveSwarmRoleGrant, type GrantSource, type SwarmRoleGrant } from './rbac/grant-sources';
export { Permission, ROLE_PERMISSIONS, Role } from './rbac/roles';
export { redactEgress } from './dlp/redactor';
