/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extract the record presentation and listing-visibility helpers verbatim out of swarm-app-service.ts, which reached 1082 code lines against the 1000-line hard cap. These three are pure functions of a record — no pool, no registry, no service state — so they read and test better beside each other than buried above a 1400-line class.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | toSummary now redacts owner identity for a viewer who is neither the owner nor an operator. A public-scoped app keeps its stamped owner_sub, and the listing serialized it to EVERY caller — a guest (mintable with no credentials) read the deployment operator's real OIDC subject off /api/swarm/apps. Redaction is viewer-CONDITIONAL, never unconditional: global search calls the listing with no viewer and compares summary.ownerSub to decide person-scope visibility, so blanking it always would silently hide a user's own apps from their own search.
 */

import type { SwarmApplicationRecord, SwarmApplicationSummary } from '../types';

/**
 * Who is being shown a summary. `null`/omitted means an INTERNAL caller (framework bookkeeping,
 * the global-search lister) that is not serializing to a browser and still needs real identity.
 */
export interface SummaryViewer {
  ownerSub: string | null;
  isOperator: boolean;
}

/**
 * @description May this viewer be shown an app's owner identity? Operators may (they administer
 * every app), and a user may see it on their own app. Everyone else — including a guest, which is
 * an authenticated-but-anonymous principal — gets it blanked. Kept separate from
 * {@link isVisibleToCaller} on purpose: that decides whether a row appears AT ALL, this decides
 * what a row that legitimately appears is allowed to say. A public app is visible to everyone and
 * still must not name its owner.
 * @param r - The stored application record.
 * @param viewer - The viewer, or null/undefined for an internal (non-serializing) caller.
 * @returns True when owner identity may be disclosed to this viewer.
 */
export function maySeeOwnerIdentity(r: SwarmApplicationRecord, viewer?: SummaryViewer | null): boolean {
  if (!viewer) return true;
  if (viewer.isOperator) return true;
  return !!viewer.ownerSub && r.ownerSub === viewer.ownerSub;
}

/**
 * @description Resolve a single display icon (codicon class) for an app from its manifest UI —
 * the first static ribbon-tile icon, else the assistant bubble icon, else null. Used so listing
 * surfaces can render a real icon rather than a first-initial placeholder.
 * @param manifest Parsed app manifest (may be undefined for bare records).
 * @returns A trimmed codicon class string, or null when no UI icon is declared.
 */
export function firstAppIcon(manifest: SwarmApplicationRecord['manifest'] | undefined): string | null {
  const staticTiles = manifest?.ui?.static;
  if (Array.isArray(staticTiles)) {
    for (const tile of staticTiles) {
      if (tile && typeof tile.icon === 'string' && tile.icon.trim()) {
        return tile.icon.trim();
      }
    }
  }
  const assistantIcon = manifest?.ui?.assistant?.icon;
  return typeof assistantIcon === 'string' && assistantIcon.trim() ? assistantIcon.trim() : null;
}

/**
 * @description Project a stored application record into the summary shape every listing surface
 * consumes, resolving the display icon and the ADR-097 primary suite along the way.
 *
 * Owner identity (`ownerSub`, `tenantId`) is emitted only when {@link maySeeOwnerIdentity} allows
 * it; otherwise both come back `null`. They stay declared rather than omitted because
 * SwarmApplicationSummary requires them and `null` is already the honest value for every
 * framework app that has no owner.
 * @param r - The stored application record.
 * @param viewer - Who this projection is for. Omit ONLY for internal callers that do not
 * serialize to a client — the global-search lister needs the real subject to match a user to
 * their own person-scoped apps.
 * @returns The listing summary for this record, owner identity redacted as appropriate.
 */
export function toSummary(r: SwarmApplicationRecord, viewer?: SummaryViewer | null): SwarmApplicationSummary {
  const showOwner = maySeeOwnerIdentity(r, viewer);
  return {
    name: r.name,
    displayName: r.displayName,
    description: r.description,
    version: r.version,
    status: r.status,
    botCount: r.agentIds.length,
    toolCount: r.toolNames.length,
    icon: firstAppIcon(r.manifest),
    suite: r.manifest?.suite ?? null,
    manifestPath: r.manifestPath,
    loadedAt: r.loadedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    // An app IS a queue (queueId === name); ticketType is the type filter key the
    // cockpit uses to scope tickets/schedules to this loaded app's queue.
    queueId: r.name,
    ticketType: r.manifest?.ticketType ?? null,
    scope: r.scope,
    ownerSub: showOwner ? r.ownerSub : null,
    tenantId: showOwner ? r.tenantId : null,
  };
}

/**
 * @description Can a caller see this app in a listing? Public apps are visible to
 * everyone; person-scoped apps only to their owner; operator-scoped apps (admin
 * tooling like security-center) to no non-operator ever; tenant-scoped apps are
 * hidden from non-operators until tenant filtering is wired. Operators bypass this
 * entirely (see listApps). Mirrors the canAccessResource owner/operator pattern in
 * authz.ts; the RLS public-read policy (migration 063) backstops it at the DB layer.
 * @param r - The stored application record.
 * @param ownerSub - The calling subject, or null when unauthenticated.
 * @returns True when the record belongs in this caller's listing.
 */
export function isVisibleToCaller(r: SwarmApplicationRecord, ownerSub: string | null): boolean {
  if (r.scope === 'public') return true;
  if (r.scope === 'person') return !!ownerSub && r.ownerSub === ownerSub;
  if (r.scope === 'operator') return false; // admin-only — operators bypass via listApps
  return false; // 'tenant' — deferred to multi-tenant wiring
}
