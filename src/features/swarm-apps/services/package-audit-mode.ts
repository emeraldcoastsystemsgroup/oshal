/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | APP-02: centralize the fail-closed package-audit rollout mode used by registry and update installer children.
 */

/** The two deliberately staged APP-02 installer postures. */
export type PackageAuditMode = 'compatible' | 'enforce';

/**
 * @description Resolve OSHAL_PACKAGE_AUDIT_MODE with a compatible rollout default while rejecting
 * unknown values, because a misspelled enforcement setting must never silently weaken installs.
 * @param value - Explicit value or the current process environment value.
 * @returns The normalized package-audit mode.
 * @throws When the configured value is neither compatible nor enforce.
 */
export function resolvePackageAuditMode(
  value: unknown = process.env.OSHAL_PACKAGE_AUDIT_MODE,
): PackageAuditMode {
  const normalized = String(value ?? '').trim().toLowerCase() || 'compatible';
  if (normalized !== 'compatible' && normalized !== 'enforce') {
    throw new Error('OSHAL_PACKAGE_AUDIT_MODE must be compatible or enforce');
  }
  return normalized;
}
