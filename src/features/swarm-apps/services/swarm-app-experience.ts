/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Resolve installation-scoped experience candidates and active member declarations through the existing application repository.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Use the shared operation binding contract without a cross-feature value dependency.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readAppDependencies } from '@/shared/app-dependencies';
import type { AuthorizationCatalog } from '@/shared/application-authorization';
import { resolveOperationPermissions } from '@/shared/application-authorization';
import type { SwarmAppManifest, SwarmApplicationRecord } from '../types';
import { isVisibleToCaller, type SummaryViewer } from './swarm-app-record-view';

/** @description Caller-visible installed experience metadata, resolved from its package declaration. */
export interface InstalledExperience {
  app: string; label: string; skin: string; shell: 'page' | 'rail'; entry: string; href: string; skinCssUrl?: string;
}
/**
 * @description Require an explicit app.open binding for every route that can own the experience entry.
 * @param manifest Validated package declaration.
 * @param catalog Loaded authorization catalog, or null for a legacy package.
 * @returns Nothing; incompatible entry bindings throw before activation.
 */
export function validateExperienceEntryCatalog(manifest: SwarmAppManifest, catalog: AuthorizationCatalog | null): void {
  const e = manifest.experience;
  if (!e) return;
  const mounts = (manifest.routes ?? []).filter(route => e.entry === route.mountPath || e.entry.startsWith(`${route.mountPath}/`));
  if (!catalog || !mounts.length || mounts.some(route => {
    const permissions = resolveOperationPermissions({ catalog },
      { app: manifest.name, kind: 'http', method: 'GET', path: e.entry.slice(route.mountPath.length) || '/' });
    return permissions?.length !== 1 || permissions[0] !== 'app.open' || catalog.permissions['app.open']?.effect !== 'read';
  })) throw new Error('experience entry must bind its named GET to app.open in the package catalog');
}
/**
 * @description Resolve installation and scope candidates; the request boundary applies current authorization.
 * @param records Installed application records.
 * @param viewer Current installation visibility identity.
 * @returns Active, scope-visible experience metadata ordered by label and application name.
 */
export function experienceCandidates(records: SwarmApplicationRecord[], viewer: SummaryViewer): InstalledExperience[] {
  return records.filter(record => record.status === 'active' && record.manifest.experience
    && (viewer.isOperator || isVisibleToCaller(record, viewer.ownerSub)))
    .map(record => {
      const e = record.manifest.experience!;
      const bundled = existsSync(resolve(dirname(record.manifestPath), 'ui', `${e.skin}.css`));
      return { app: record.name, label: e.label, skin: e.skin, shell: e.shell, entry: e.entry,
        href: `/api/ui/experiences/${encodeURIComponent(record.name)}/open`,
        ...(bundled ? { skinCssUrl: `/api/swarm/apps/${encodeURIComponent(record.name)}/theme.css` } : {}) };
    }).sort((a, b) => a.label.localeCompare(b.label) || a.app.localeCompare(b.app));
}
/**
 * @description Resolve active required and optional members without turning optional apps into hard dependencies.
 * @param manifest Experience package declaration.
 * @param find Existing application repository lookup.
 * @returns Active member manifests keyed by application name.
 */
export async function activeExperienceMembers(manifest: SwarmAppManifest,
  find: (name: string) => Promise<SwarmApplicationRecord | null>): Promise<Map<string, SwarmAppManifest>> {
  const members = new Map<string, SwarmAppManifest>();
  const dependencies = readAppDependencies(manifest);
  for (const name of [...dependencies.required.apps, ...dependencies.optional.apps]) {
    const record = await find(name);
    if (record?.status === 'active') members.set(name, record.manifest);
  }
  return members;
}
