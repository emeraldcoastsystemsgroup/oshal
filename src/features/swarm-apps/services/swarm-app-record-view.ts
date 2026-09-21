/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extract the record presentation and listing-visibility helpers verbatim out of swarm-app-service.ts, which reached 1082 code lines against the 1000-line hard cap. These three are pure functions of a record — no pool, no registry, no service state — so they read and test better beside each other than buried above a 1400-line class.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | toSummary now redacts owner identity for a viewer who is neither the owner nor an operator. A public-scoped app keeps its stamped owner_sub, and the listing serialized it to EVERY caller — a guest (mintable with no credentials) read the deployment operator's real OIDC subject off /api/swarm/apps. Redaction is viewer-CONDITIONAL, never unconditional: global search calls the listing with no viewer and compares summary.ownerSub to decide person-scope visibility, so blanking it always would silently hide a user's own apps from their own search.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The summary carries hasSurface, so a listing surface can tell an app that opens into a cockpit from one that genuinely has no screen without re-reading a manifest it is not given. The applications catalog was deciding that from a hand-typed name array, which no core manifest could ever join by shipping a rail; five apps with real surfaces rendered "Coming soon". Derived here beside firstAppIcon because it reads the same manifest.ui block, and a second copy of the rule is how two surfaces start disagreeing about which apps are openable.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The summary carries the bundle's declared connector provider ids, split into the ADR-085 required/optional tiers. The applications catalog listed installed and available packages with no way to show which providers a bundle includes, so it could not distinguish a connected bundle from one waiting on a credential - the whole of the "apps page as a swarm catalog" gap. Read through the SHARED tier contract (@/shared/app-dependencies), which the installer and the loader already use, rather than the raw `dependencies` keys: the flat and tiered forms differ, and a second reader of them is how two surfaces start disagreeing about what a package depends on. Lenient by design (inspect, not read): a stored record whose block is malformed contributes no connectors instead of making the whole listing throw.
 */

import { inspectAppDependencies } from '@/shared/app-dependencies';
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
 * @description Does this app declare anything a cockpit can open? True for `ui.static` tiles, for
 * a `ui.dynamic` row source (its tiles come from a table, so the rail is real even though no tile
 * is written down), and for an ADR-141 group, which carries no `ui` of its own and instead borrows
 * its members' surfaces through `toolbar` and lands on the kernel setup dashboard.
 *
 * Kept separate from {@link firstAppIcon} even though both read `manifest.ui`: an icon is optional
 * decoration on a tile, so "has no icon" and "has no surface" are different facts, and reusing the
 * icon as the openability signal would call a tile-without-an-icon headless. Lifecycle `status` is
 * not consulted — deactivating an app does not remove the surface its manifest declares, and the
 * listing already reports status separately.
 * @param manifest - Parsed app manifest (may be undefined for bare records).
 * @returns True when the manifest declares a surface to open.
 */
export function hasCockpitSurface(manifest: SwarmApplicationRecord['manifest'] | undefined): boolean {
  if (!manifest) return false;
  if (Array.isArray(manifest.ui?.static) && manifest.ui.static.length > 0) return true;
  if (manifest.ui?.dynamic) return true;
  return manifest.kind === 'group' && Array.isArray(manifest.toolbar) && manifest.toolbar.length > 0;
}

/**
 * @description The connector provider ids a manifest declares, split into the ADR-085 tiers —
 * `required` (the app cannot do its job without the provider) and `optional` (it works without
 * it). Read through the shared dependency contract rather than the raw `dependencies` keys,
 * because the legacy flat form and the tiered form put the same list in different places and a
 * second reader of them is how two surfaces start disagreeing about a package.
 *
 * Deliberately lenient: {@link inspectAppDependencies} collects problems instead of throwing, so a
 * stored record with a hand-edited block contributes no connectors rather than failing the whole
 * listing. An id here is a DECLARATION only — it says the bundle includes that provider, never
 * that anything is connected; live state comes from the broker, which a listing joins separately.
 * @param manifest - Parsed app manifest (may be undefined for bare records).
 * @returns The declared provider ids per tier; empty lists when the manifest declares none.
 */
export function declaredConnectors(
  manifest: SwarmApplicationRecord['manifest'] | undefined,
): { required: string[]; optional: string[] } {
  if (!manifest) return { required: [], optional: [] };
  const tiers = inspectAppDependencies(manifest);
  const required = [...new Set(tiers.required.connectors)];
  const requiredSet = new Set(required);
  // A provider named in both tiers is required: the stricter tier is the honest one, and the
  // contract already reports the duplicate as a problem the loader surfaces at install time.
  return { required, optional: [...new Set(tiers.optional.connectors)].filter((id) => !requiredSet.has(id)) };
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
    hasSurface: hasCockpitSurface(r.manifest),
    suite: r.manifest?.suite ?? null,
    connectors: declaredConnectors(r.manifest),
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
