/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extract the record presentation and listing-visibility helpers verbatim out of swarm-app-service.ts, which reached 1082 code lines against the 1000-line hard cap. These three are pure functions of a record — no pool, no registry, no service state — so they read and test better beside each other than buried above a 1400-line class.
 */

import type { SwarmApplicationRecord, SwarmApplicationSummary } from '../types';

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
 * @param r - The stored application record.
 * @returns The listing summary for this record.
 */
export function toSummary(r: SwarmApplicationRecord): SwarmApplicationSummary {
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
    ownerSub: r.ownerSub,
    tenantId: r.tenantId,
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
