/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-149 rail discoverability. A launcher-shaped app (Create, Life, Games, the creative bundle) declares ui.static tiles whose iframeUrl sits under ANOTHER package's mount. Under enforce mode that package may be unprovisioned for the signed-in person, and the manifest-static rail rendered the tile anyway — a click landed on the kernel's role-guidance 403 inside the frame. lockUndiscoverableTiles resolves, for each tile under another ACTIVE package's mount (longest mount wins; the app's own mounts and paths no package owns are never touched), that package's canDiscover through a port the route binds to the verified actor, and marks a non-discoverable target `locked` — kept in place, so the cockpit renders it in the guest-disabled style with the role-guidance link. An ADR-141 group borrows every tile, so each borrowed tile follows its member. Lives beside swarm-app-group.ts because swarm-app-service.ts is over its size budget.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | openableDefaultView: the landing half of the same rule. Locking the rail button left the LANDING view alone, so an app whose ribbon.defaultView names a tile under another package's mount (life -> life-movies, games -> games-dnd) still opened straight onto the kernel's role-guidance 403 inside the frame for a person who cannot discover that target — the tile showed locked in the rail while the content area showed the dead frame. The landing choice now skips a locked tile: the declared one when it is openable, else the first openable tile, else the first framework item.
 */

import { createChildLogger } from '@/shared/logger';
import type { SwarmAppManifest } from '../types';

const logger = createChildLogger({ module: 'swarm-app-tile-discoverability' });

/**
 * The port synthesiseProfile uses to ask, on behalf of the signed-in person, whether a package may
 * be discovered. The route binds it to the verified actor; this slice never sees the runtime.
 */
export interface RibbonTileDiscovery {
  /** The runtime's coarse discovery check for one ACTIVE package (a legacy-mode package answers true). */
  canDiscover(appName: string): Promise<boolean>;
  /** Where the kernel's role-guidance page sends this person — the same link its 403 body offers. */
  roleGuidanceUrl: string;
}

/** Why a tile is locked and where to go about it. Present only when the target is not discoverable. */
export interface RibbonTileLock {
  /** The ACTIVE package whose mount owns the tile's surface. */
  app: string;
  reason: 'application-role-required';
  roleGuidanceUrl: string;
}

/** The part of a ribbon item this module reads: the surface the tile opens. */
export interface RibbonTileTarget {
  toolUi: { iframeUrl: string };
}

/** The part of an installed record this module reads. */
export interface MountOwnerRecord {
  name: string;
  status: 'active' | 'inactive';
  manifest: Pick<SwarmAppManifest, 'routes'>;
}

interface MountOwner {
  name: string;
  mounts: string[];
}

/**
 * @description The HTTP mounts a manifest declares, normalised the way the authorization runtime
 * matches them (no trailing slash, no duplicates). A group declares none — it carries no code.
 * @param manifest - Any manifest.
 * @returns Root-relative mount prefixes.
 */
export function packageMounts(manifest: Pick<SwarmAppManifest, 'routes'>): string[] {
  const mounts = new Set<string>();
  for (const route of manifest.routes ?? []) {
    const mount = typeof route.mountPath === 'string' ? route.mountPath.replace(/\/+$/, '') : '';
    if (mount.startsWith('/')) mounts.add(mount);
  }
  return [...mounts];
}

/**
 * @description The pathname of a tile's surface URL, or null when the URL is not a same-origin
 * root-relative path (the only shape a manifest tile may carry; anything else is left alone).
 * @param iframeUrl - The tile's declared surface.
 * @returns The pathname without query or fragment, or null.
 */
export function tilePathname(iframeUrl: string): string | null {
  if (typeof iframeUrl !== 'string' || !/^\/(?!\/)/.test(iframeUrl)) return null;
  return iframeUrl.split(/[?#]/, 1)[0];
}

/**
 * @description The package whose mount owns a pathname — the longest matching mount wins, exactly
 * as the authorization runtime resolves an HTTP owner — or undefined when no package owns it.
 * @param pathname - A root-relative pathname.
 * @param owners - Every candidate package with its mounts.
 * @returns The owning package's name, or undefined.
 */
export function mountOwner(pathname: string, owners: readonly MountOwner[]): string | undefined {
  let best: { name: string; length: number } | undefined;
  for (const owner of owners) {
    for (const mount of owner.mounts) {
      if (pathname !== mount && !pathname.startsWith(`${mount}/`)) continue;
      if (!best || mount.length > best.length) best = { name: owner.name, length: mount.length };
    }
  }
  return best?.name;
}

/**
 * @description Marks every tile whose surface sits under ANOTHER active package's mount as locked
 * when that package is not discoverable by the person the port was bound to. A tile under the
 * app's own mount, or on a path no package owns, is returned untouched; the input is never mutated
 * and no manifest changes. Each target package is asked once. A port failure is logged and leaves
 * the tile as it was — discovery can hide, never authorise, so the mount guard stays the authority.
 * @param owner - The app (or group) whose rail is being synthesised.
 * @param tiles - Its static ribbon items, in rail order.
 * @param installed - Every installed record; only ACTIVE ones can own a mount.
 * @param discovery - The per-person discovery port.
 * @returns The same tiles, in the same order, with `locked` on the non-discoverable ones.
 */
export async function lockUndiscoverableTiles<T extends RibbonTileTarget>(
  owner: { name: string; manifest: Pick<SwarmAppManifest, 'routes'> },
  tiles: readonly T[],
  installed: readonly MountOwnerRecord[],
  discovery: RibbonTileDiscovery,
): Promise<Array<T & { locked?: RibbonTileLock }>> {
  const owners: MountOwner[] = [
    { name: owner.name, mounts: packageMounts(owner.manifest) },
    ...installed
      .filter((record) => record.status === 'active' && record.name !== owner.name)
      .map((record) => ({ name: record.name, mounts: packageMounts(record.manifest) })),
  ];
  const answers = new Map<string, Promise<boolean | null>>();
  const discoverable = (app: string): Promise<boolean | null> => {
    let pending = answers.get(app);
    if (!pending) {
      pending = discovery.canDiscover(app).catch((err: unknown) => {
        logger.error({ err, app: owner.name, target: app }, 'Rail discoverability check failed — tile left as declared');
        return null;
      });
      answers.set(app, pending);
    }
    return pending;
  };
  const result: Array<T & { locked?: RibbonTileLock }> = [];
  for (const tile of tiles) {
    const pathname = tilePathname(tile.toolUi.iframeUrl);
    const target = pathname ? mountOwner(pathname, owners) : undefined;
    if (!target || target === owner.name || (await discoverable(target)) !== false) { result.push(tile); continue; }
    logger.info({ app: owner.name, target, surface: pathname }, 'Rail tile locked — target package is not discoverable for this person');
    result.push({ ...tile, locked: { app: target, reason: 'application-role-required', roleGuidanceUrl: discovery.roleGuidanceUrl } });
  }
  return result;
}

/** The part of a synthesised ribbon item the landing choice reads. */
export interface RibbonTileChoice {
  id: string;
  locked?: RibbonTileLock;
}

/**
 * @description The view the cockpit should land on. A locked tile is kept in the rail but must
 * never be the landing view: the shell would iframe its surface before the person ever clicks,
 * putting the kernel's role-guidance 403 in the content area — the dead frame this whole path
 * exists to remove. So a declared `ribbon.defaultView` that resolves to a locked tile falls
 * through to the first tile that IS openable, and to the first framework item when every static
 * tile is locked. Behaviour with no lock anywhere is exactly the previous one: the declared tile,
 * else the first static tile; a declared id that matches no static tile (a framework id) rides
 * through untouched, and an app with no static tiles still returns nothing.
 * @param declared - The manifest's raw `ribbon.defaultView` toolName, if any.
 * @param staticItems - The synthesised static tiles, in rail order, with any `locked` marks.
 * @param frameworkItems - The framework ribbon ids left after the manifest's hides.
 * @returns The view id to land on, or undefined to leave the choice to the shell.
 */
export function openableDefaultView(
  declared: string | undefined,
  staticItems: readonly RibbonTileChoice[],
  frameworkItems: readonly string[],
): string | undefined {
  const match = declared ? staticItems.find((item) => item.id === `tool-${declared}` || item.id === declared) : undefined;
  if (declared && !match) return declared;
  if (match && !match.locked) return match.id;
  const openable = staticItems.find((item) => !item.locked);
  if (match) logger.info({ declared, landing: openable?.id ?? frameworkItems[0] }, 'Declared landing tile is locked for this person — landing on an openable view');
  if (openable) return openable.id;
  return staticItems.length ? frameworkItems[0] : undefined;
}
