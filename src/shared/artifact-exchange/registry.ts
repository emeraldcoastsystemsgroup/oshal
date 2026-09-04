/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 Stage 1: the shared in-memory "Send to…" registry — apps write it on activate and clear it on deactivate (modeled on skill-profiles/registry.ts), the menu route reads it. Lives in shared/ so the WRITER (features/swarm-apps) and the READER (app/routes) both reach it top-down. Keyed by appName: re-activate REPLACES, deactivate drops the whole entry — full teardown, no per-action bookkeeping.
 */

import { createChildLogger } from '@/shared/logger';
import {
  matchesArtifactType,
  type ArtifactAcceptDeclaration,
  type ArtifactActionsDeclaration,
  type ArtifactProvideDeclaration,
} from './types';

const logger = createChildLogger({ module: 'artifact-exchange:registry' });

/** @description One registered app's validated artifact declarations. */
interface RegisteredArtifactActions {
  appName: string;
  accepts: ArtifactAcceptDeclaration[];
  provides: ArtifactProvideDeclaration[];
}

/**
 * @description One resolved "Send to…" menu entry for a concrete artifact type. `endpoint` is
 * present only for post-mode actions (it is a same-origin, auth-gated app path — the browser
 * component POSTs `{ ref }` to it); open-mode dispatch needs only the app name (ADR-139 D4a).
 */
export interface ArtifactMenuAction {
  app: string;
  id: string;
  label: string;
  icon?: string;
  mode: 'open' | 'post';
  endpoint?: string;
}

/** Keyed by appName so re-activate replaces and deactivate drops the whole entry in one delete. */
const BY_APP = new Map<string, RegisteredArtifactActions>();

/**
 * @description Register (or replace) an app's VALIDATED artifact declarations. Called from
 * swarm-app activate() (and at boot for kernel built-ins — same interface, no special cases).
 * The caller is responsible for validation (the loader fails the app load on a malformed block);
 * an empty declaration is a no-op — the activate path retracts instead (mirror applySkillProfiles).
 * @param appName - The owning app (or kernel capability) name.
 * @param decl - The validated `artifacts:` declaration.
 */
export function registerAppArtifactActions(appName: string, decl: ArtifactActionsDeclaration): void {
  const accepts = decl.accepts ?? [];
  const provides = decl.provides ?? [];
  if (!appName || (accepts.length === 0 && provides.length === 0)) return;
  BY_APP.set(appName, { appName, accepts, provides });
  logger.info(
    { app: appName, accepts: accepts.map((a) => a.id), provides: provides.length },
    'Registered app artifact actions',
  );
}

/**
 * @description Retract an app's artifact declarations (deactivate / uninstall). Idempotent —
 * a toggled-off app must hold zero live menu entries.
 * @param appName - The app whose declarations to clear.
 */
export function unregisterAppArtifactActions(appName: string): void {
  if (BY_APP.delete(appName)) {
    logger.info({ app: appName }, 'Retracted app artifact actions');
  }
}

/**
 * @description Every registered action whose type globs match a concrete MIME type — the
 * "Send to…" menu for one artifact. Stable order (app name, then action id) so the menu does
 * not shuffle between opens. Enforcement stays at the destination: an entry the caller may not
 * use fails closed at the destination's own auth/tier gate on dispatch.
 * @param mime - The artifact's MIME type (parameters ignored).
 * @returns The matching menu entries.
 */
export function artifactActionsForType(mime: string): ArtifactMenuAction[] {
  const out: ArtifactMenuAction[] = [];
  for (const entry of BY_APP.values()) {
    for (const a of entry.accepts) {
      if (a.types.some((glob) => matchesArtifactType(glob, mime))) {
        out.push({
          app: entry.appName,
          id: a.id,
          label: a.label,
          ...(a.icon ? { icon: a.icon } : {}),
          mode: a.mode,
          ...(a.mode === 'post' && a.endpoint ? { endpoint: a.endpoint } : {}),
        });
      }
    }
  }
  return out.sort((x, y) => (x.app === y.app ? x.id.localeCompare(y.id) : x.app.localeCompare(y.app)));
}

/**
 * @description Read-only view of the registry for snapshots and tests (the skill-profiles
 * convention) — callers must not mutate it.
 * @returns The appName → declarations map.
 */
export function registeredArtifactActionApps(): ReadonlyMap<string, { accepts: ArtifactAcceptDeclaration[]; provides: ArtifactProvideDeclaration[] }> {
  return BY_APP;
}
