export interface RagPermissionMetadata {
  tenant_id?: string | null;
  owner_sub?: string | null;
  allowed_users?: string | string[] | null;
  allowed_groups?: string | string[] | null;
  [key: string]: unknown;
}

export interface RagPermissionContext {
  userSub: string;
  tenantId?: string | null;
  groups?: readonly string[];
  /**
   * The caller's source-system identities (e.g. verified email addresses). Native source ACLs
   * (a Google Drive file shared to `alice@corp.com`, a GitHub collaborator) grant by email, not by
   * OSHAL sub, so a chunk's `allowed_users` is matched against the caller's sub UNION these emails.
   * Unknown/unresolvable identities never match — access is fail-closed.
   */
  emails?: readonly string[];
  isOperator?: boolean;
  allowPublic?: boolean;
}

export type RagPermissionBasis = 'operator' | 'owner' | 'explicit-user' | 'group' | 'public';

export interface PermissionedRagHit<T extends { metadata?: RagPermissionMetadata | null }> {
  hit: T;
  permissionBasis: RagPermissionBasis;
}

export function canReadRagMetadata(metadata: RagPermissionMetadata | null | undefined, context: RagPermissionContext): boolean {
  return permissionBasisForRagMetadata(metadata, context) !== null;
}

export function permissionBasisForRagMetadata(
  metadata: RagPermissionMetadata | null | undefined,
  context: RagPermissionContext,
): PermissionedRagHit<{ metadata?: RagPermissionMetadata }>['permissionBasis'] | null {
  if (context.isOperator) {
    return 'operator';
  }

  const tenantId = normalized(metadata?.tenant_id);
  const contextTenantId = normalized(context.tenantId);
  if (tenantId && contextTenantId && tenantId !== contextTenantId) {
    return null;
  }

  const ownerSub = normalized(metadata?.owner_sub);
  if (ownerSub && ownerSub === normalized(context.userSub)) {
    return 'owner';
  }

  // Match allowed_users against the caller's OSHAL sub UNION their source-system identities
  // (emails). Native source ACLs grant by email; OSHAL-native ingest grants by sub. Both are
  // checked so a Drive file shared to alice@corp.com is readable by the OSHAL user who owns that
  // verified email, without a pre-sync step. Empty/unknown identities are filtered out so they
  // can never match a chunk that happens to carry an empty allowed_users entry.
  const callerIdentities = new Set(
    [normalized(context.userSub), ...(context.emails ?? []).map(normalized)].filter(Boolean),
  );
  const allowedUsers = normalizeList(metadata?.allowed_users);
  if (allowedUsers.some((user) => callerIdentities.has(user))) {
    return 'explicit-user';
  }

  const callerGroups = new Set((context.groups ?? []).map(normalized).filter(Boolean));
  const allowedGroups = normalizeList(metadata?.allowed_groups);
  if (allowedGroups.some((group) => callerGroups.has(group))) {
    return 'group';
  }

  const hasAcl = Boolean(ownerSub || allowedUsers.length > 0 || allowedGroups.length > 0 || tenantId);
  if (!hasAcl && context.allowPublic) {
    return 'public';
  }

  return null;
}

export function filterRagHitsByPermission<T extends { metadata?: RagPermissionMetadata | null }>(
  hits: readonly T[],
  context: RagPermissionContext,
): Array<PermissionedRagHit<T>> {
  const readable: Array<PermissionedRagHit<T>> = [];
  for (const hit of hits) {
    const permissionBasis = permissionBasisForRagMetadata(hit.metadata, context);
    if (permissionBasis) {
      readable.push({ hit, permissionBasis });
    }
  }
  return readable;
}

/**
 * Apply permission filtering to a ranked hit list and stamp each surviving hit with the basis on
 * which the caller may read it, then trim to `topK`. This is the single seam a retrieval path calls
 * so that "who asked" is enforced before results leave the service — unreadable chunks are dropped,
 * not just hidden in the UI.
 *
 * @param hits Ranked candidate hits (already over-fetched so filtering still yields enough).
 * @param context The caller's identity/scope.
 * @param topK Maximum number of readable hits to return.
 * @returns The readable hits in rank order, each with `permissionBasis`, capped at topK.
 */
export function applyRagPermission<T extends { metadata?: RagPermissionMetadata | null }>(
  hits: readonly T[],
  context: RagPermissionContext,
  topK: number,
): Array<T & { permissionBasis: RagPermissionBasis }> {
  return filterRagHitsByPermission(hits, context)
    .map(({ hit, permissionBasis }) => ({ ...hit, permissionBasis }))
    .slice(0, Math.max(0, topK));
}

function normalizeList(value: string | string[] | null | undefined): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw.map(normalized).filter(Boolean);
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
