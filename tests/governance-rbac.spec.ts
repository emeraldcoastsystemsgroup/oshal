/**
 * Governance RBAC policy tests (additive, enforcement off by default).
 *
 * Proves the backward-compatibility contract:
 *  - enforcement OFF (default): can() returns ALLOW for everyone, every permission (nobody is
 *    locked out by merging this);
 *  - enforcement ON: admin holds audit.export, a viewer does not;
 *  - resolveRole maps the existing operator allowlist (OSHAL_OPERATOR_*) to admin, the optional
 *    OSHAL_RBAC_OPERATOR_* allowlist to operator, everyone else to viewer;
 *  - owner-or-admin: a non-admin owner is allowed on their own resource under enforcement.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — unit tests for opt-in RBAC policy.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard exact, case-sensitive OIDC subject matching on both privileged allowlists while preserving delimiter trimming and case-insensitive email behavior.
 */
import { test, expect } from '@playwright/test';
import { can, resolveRole, isEnforcementEnabled, type RbacCaller } from '@/features/governance/rbac/policy';
import { Role, Permission } from '@/features/governance/rbac/roles';

const ADMIN: RbacCaller = { sub: 'admin-sub-1', email: 'admin@example.com' };
const OPERATOR: RbacCaller = { sub: 'op-sub-1', email: 'op@example.com' };
const VIEWER: RbacCaller = { sub: 'viewer-sub-1', email: 'viewer@example.com' };

test.beforeEach(() => {
  delete process.env.OSHAL_RBAC_ENFORCE;
  delete process.env.OSHAL_OPERATOR_SUBS;
  delete process.env.OSHAL_OPERATOR_EMAILS;
  delete process.env.OSHAL_RBAC_OPERATOR_SUBS;
  delete process.env.OSHAL_RBAC_OPERATOR_EMAILS;
});

test('enforcement off by default — isEnforcementEnabled is false', () => {
  expect(isEnforcementEnabled()).toBe(false);
});

test('enforcement off — can() is permissive ALLOW for everyone, every permission', () => {
  for (const caller of [ADMIN, OPERATOR, VIEWER, null, { sub: null, email: null }]) {
    for (const perm of Object.values(Permission)) {
      expect(can(caller, perm)).toBe(true);
    }
  }
});

test('enforcement off — even an unknown permission is allowed (backward compat)', () => {
  expect(can(VIEWER, 'totally.unknown.permission' as Permission)).toBe(true);
});

test('resolveRole maps operator allowlist (sub) to admin', () => {
  process.env.OSHAL_OPERATOR_SUBS = 'admin-sub-1, other-sub';
  expect(resolveRole(ADMIN)).toBe(Role.Admin);
});

test('resolveRole maps operator allowlist (email, case-insensitive) to admin', () => {
  process.env.OSHAL_OPERATOR_EMAILS = 'Admin@Example.com';
  expect(resolveRole(ADMIN)).toBe(Role.Admin);
});

test('resolveRole maps the optional RBAC operator allowlist to operator', () => {
  process.env.OSHAL_RBAC_OPERATOR_SUBS = 'op-sub-1';
  expect(resolveRole(OPERATOR)).toBe(Role.Operator);
});

test('subject allowlists are exact: case and caller whitespace cannot inherit privilege', () => {
  process.env.OSHAL_OPERATOR_SUBS = ' admin-sub-1 ';
  process.env.OSHAL_RBAC_OPERATOR_SUBS = ' op-sub-1 ';

  expect(resolveRole(ADMIN)).toBe(Role.Admin);
  expect(resolveRole(OPERATOR)).toBe(Role.Operator);
  for (const sub of ['ADMIN-SUB-1', ' admin-sub-1', 'admin-sub-1 ']) {
    expect(resolveRole({ sub, email: null })).toBe(Role.Viewer);
  }
  for (const sub of ['OP-SUB-1', ' op-sub-1', 'op-sub-1 ']) {
    expect(resolveRole({ sub, email: null })).toBe(Role.Viewer);
  }
});

test('resolveRole defaults to viewer for anyone not on an allowlist (incl. unauthenticated)', () => {
  expect(resolveRole(VIEWER)).toBe(Role.Viewer);
  expect(resolveRole(null)).toBe(Role.Viewer);
  expect(resolveRole({ sub: null, email: null })).toBe(Role.Viewer);
});

test('enforcement on — admin can audit.export, viewer cannot', () => {
  process.env.OSHAL_RBAC_ENFORCE = 'true';
  process.env.OSHAL_OPERATOR_SUBS = 'admin-sub-1';

  expect(resolveRole(ADMIN)).toBe(Role.Admin);
  expect(can(ADMIN, Permission.AuditExport)).toBe(true);

  expect(resolveRole(VIEWER)).toBe(Role.Viewer);
  expect(can(VIEWER, Permission.AuditExport)).toBe(false);
});

test('enforcement on — viewer keeps its default read grant', () => {
  process.env.OSHAL_RBAC_ENFORCE = 'true';
  expect(can(VIEWER, Permission.TicketRead)).toBe(true);
  expect(can(VIEWER, Permission.TicketWrite)).toBe(false);
});

test('enforcement on — owner is allowed on their own resource even without the role grant', () => {
  process.env.OSHAL_RBAC_ENFORCE = 'true';
  // Viewer lacks ticket.write by role, but owns this resource -> allowed.
  expect(can(VIEWER, Permission.TicketWrite, { ownerSub: VIEWER.sub })).toBe(true);
  // Non-owner viewer on someone else's resource -> denied.
  expect(can(VIEWER, Permission.TicketWrite, { ownerSub: 'someone-else' })).toBe(false);
});

test('enforcement on — operator holds tool.approve but not governance.admin', () => {
  process.env.OSHAL_RBAC_ENFORCE = 'true';
  process.env.OSHAL_RBAC_OPERATOR_SUBS = 'op-sub-1';
  expect(can(OPERATOR, Permission.ToolApprove)).toBe(true);
  expect(can(OPERATOR, Permission.GovernanceAdmin)).toBe(false);
});
