/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Created the governance feature barrel (FSD deep-import burn-down): surfaces the audit capture/emit API, the RBAC policy middleware + role/permission model, and the DLP egress redactor that consumers were reaching via deep paths.
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
} from './rbac/policy';
export { Permission, ROLE_PERMISSIONS, Role } from './rbac/roles';
export { redactEgress } from './dlp/redactor';
