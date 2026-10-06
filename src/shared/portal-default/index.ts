/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (B1, B3): the one reserved owner for portal-default rows, and the one resolver shape. A portal default is a row in the same table as people's own settings, owned by 'portal-default', which no person's subject can equal (identity-provider subjects are opaque ids; local subjects are 'local-' plus 16 hex). resolvePortalDefault reads the person's own row, then the portal-default row, and reports which answered, so a screen can label a fallen-back value "Portal default" exactly as ADR-173's panels do. ADR-173's capability tables keep their own reserved scope ('fleet-default'); new tables use this one.
 */

/** The reserved owner of a portal-default row (ADR-174 Amendment B, B1). */
export const PORTAL_DEFAULT_OWNER = 'portal-default';

/**
 * @description Whether an owner value names the portal default rather than a person.
 * @param owner - The owner column's value, or a caller's subject.
 * @returns true for the reserved owner, exactly.
 */
export function isPortalDefaultOwner(owner: string | null | undefined): boolean {
  return owner === PORTAL_DEFAULT_OWNER;
}

/** Which row answered a resolution. */
export type PortalDefaultSource = 'own' | 'portal-default';

/** A resolved value and where it came from. */
export interface PortalDefaultResolution<T> {
  value: T;
  source: PortalDefaultSource;
}

/**
 * @description The one resolver shape (ADR-174 Amendment B, B3): the person's own row first, then the
 * portal-default row, never another person's. The reader is called with the owner to read for; a
 * caller with no subject (an anonymous or system read) gets only the portal default. A null result
 * means neither row exists, and the caller answers as D3 says: a clear refusal naming what is
 * missing, or a documented built-in default.
 * @param readRow - Reads one owner's row, or null when there is none.
 * @param sub - The person's subject; null when there is no person.
 * @returns The value and its source, or null when neither row exists.
 */
export async function resolvePortalDefault<T>(
  readRow: (owner: string) => Promise<T | null | undefined>,
  sub: string | null | undefined,
): Promise<PortalDefaultResolution<T> | null> {
  if (typeof sub === 'string' && sub.length > 0 && !isPortalDefaultOwner(sub)) {
    const own = await readRow(sub);
    if (own !== null && own !== undefined) return { value: own, source: 'own' };
  }
  const shared = await readRow(PORTAL_DEFAULT_OWNER);
  return shared === null || shared === undefined ? null : { value: shared, source: 'portal-default' };
}
