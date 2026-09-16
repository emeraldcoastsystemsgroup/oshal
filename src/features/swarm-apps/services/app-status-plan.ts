/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-145 D4: getAppStatusPlan resolves ONE name to a status plan — an ACTIVE group (its members' summary probes and readiness steps, exactly as ADR-141 already resolved them) or a single ACTIVE app (members: [name], steps from its own readiness:). An app that belongs to no group had nowhere to report even when it declared a probe; this is the one branch that fixes that, without synthesising an implicit one-member group (which would leak into ribbon synthesis, the toolbar resolver and assertGroupResolvable). Pure: manifests in, plan out — it asks no probe and reads no app table, because the page asks every probe itself in the viewer's own session (ADR-145 D6). New module rather than swarm-app-service.ts, which is past its 800-line budget.
 *
 * @module app-status-plan
 */

import type { SwarmAppManifest } from '../types';
import { requiredAppDependencies } from '@/shared/app-dependencies';
import {
  isGroupManifest,
  resolveGroupSetup,
  resolveGroupToolbar,
  type ResolvedGroupSetupStep,
} from './swarm-app-group';
import { humaniseReadinessSlug, type HomePlanSummaryProbe } from './app-home-plan';

/** One app's summary probe, carrying the display name the card's heading needs. */
export interface AppStatusSummaryProbe extends HomePlanSummaryProbe {
  appDisplayName: string;
}

/** An app in the plan that declared no `summary:` — the ADR-145 D5 fallback applies to it. */
export interface AppStatusUndeclaredApp {
  name: string;
  displayName: string;
}

/**
 * The status-dashboard plan for ONE name. `group` is kept verbatim from the ADR-141 response so
 * the shipped page and any existing caller read an unchanged shape when the name is a group.
 */
export interface AppStatusPlan {
  /** The resolved manifest name — a group, or a plain app. */
  name: string;
  /** ADR-141 compatibility: the group plan has always named itself here. */
  group: string;
  kind: 'app' | 'group';
  displayName: string;
  description?: string;
  /** The group's active members, or `[name]` for a plain app (ADR-145 D4). */
  members: string[];
  /** Ribbon surface the page's "Open" action opens. */
  firstSurface?: string;
  /** Apps in this plan with no `summary:` declaration, in member order. */
  undeclared: AppStatusUndeclaredApp[];
  summary: AppStatusSummaryProbe[];
  steps: ResolvedGroupSetupStep[];
}

/**
 * @description The summary probe one manifest contributes, or nothing when it declares none.
 * `surfaces` carries the app's own `ui.static[].toolName`s so the page can refuse a `fix` that
 * names a surface the app does not own (ADR-145 D2 — `fix` is same-app by contract).
 * @param manifest - An active app manifest.
 * @returns A one-element array when the app declares `summary:`, else an empty one.
 */
function summaryProbeFor(manifest: SwarmAppManifest): AppStatusSummaryProbe[] {
  const decl = manifest.summary;
  if (!decl) return [];
  return [{
    app: manifest.name,
    appDisplayName: manifest.displayName,
    path: decl.path,
    ...(decl.tilesPointer ? { tilesPointer: decl.tilesPointer } : {}),
    ...(decl.itemsPointer ? { itemsPointer: decl.itemsPointer } : {}),
    ...(decl.metricsPointer ? { metricsPointer: decl.metricsPointer } : {}),
    surfaces: (manifest.ui?.static ?? []).map((surface) => surface.toolName),
  }];
}

/**
 * @description The readiness steps a PLAIN app contributes. A group writes the human sentence in
 * its `setup[]`; an app on its own has only the slug, so it is humanised the way the Home plan
 * already humanises an unlabelled member probe. No `fix`: only a group's setup[] names one.
 * @param manifest - An active app manifest.
 * @returns One step per declared readiness probe, in declaration order.
 */
function appSetupSteps(manifest: SwarmAppManifest): ResolvedGroupSetupStep[] {
  return (manifest.readiness ?? []).map((decl) => ({
    label: humaniseReadinessSlug(decl.name),
    app: manifest.name,
    appDisplayName: manifest.displayName,
    readiness: decl.name,
    probe: {
      path: decl.path,
      readyPointer: decl.readyPointer,
      ...(decl.detailPointer ? { detailPointer: decl.detailPointer } : {}),
    },
  }));
}

/**
 * @description The plan for an ADR-141 group: its ACTIVE members' summary probes and the setup
 * steps resolved against them. A member that is not active is skipped for summary and reported
 * `unavailable` by the setup resolver — never rendered as done.
 * @param group - The group manifest.
 * @param byName - Every active manifest, keyed by name.
 * @returns The group's status plan.
 */
function groupPlan(group: SwarmAppManifest, byName: ReadonlyMap<string, SwarmAppManifest>): AppStatusPlan {
  const members = new Map<string, SwarmAppManifest>();
  for (const name of requiredAppDependencies(group)) {
    const member = byName.get(name);
    if (member) members.set(name, member);
  }
  const firstSurface = resolveGroupToolbar(group, members).tiles[0]?.toolName;
  const active = [...members.values()];
  return {
    name: group.name,
    group: group.name,
    kind: 'group',
    displayName: group.displayName,
    ...(group.description ? { description: group.description } : {}),
    members: [...members.keys()],
    ...(firstSurface ? { firstSurface } : {}),
    undeclared: active.filter((m) => !m.summary).map((m) => ({ name: m.name, displayName: m.displayName })),
    summary: active.flatMap(summaryProbeFor),
    steps: resolveGroupSetup(group, members),
  };
}

/**
 * @description The plan for a plain app: itself as its only member (ADR-145 D4), its own summary
 * probe when it declares one, and its own readiness probes as steps.
 * @param manifest - The app manifest.
 * @returns The app's status plan.
 */
function appPlan(manifest: SwarmAppManifest): AppStatusPlan {
  const firstSurface = manifest.ui?.static?.[0]?.toolName;
  return {
    name: manifest.name,
    group: manifest.name,
    kind: 'app',
    displayName: manifest.displayName,
    ...(manifest.description ? { description: manifest.description } : {}),
    members: [manifest.name],
    ...(firstSurface ? { firstSurface } : {}),
    undeclared: manifest.summary ? [] : [{ name: manifest.name, displayName: manifest.displayName }],
    summary: summaryProbeFor(manifest),
    steps: appSetupSteps(manifest),
  };
}

/**
 * @description Resolve ONE name to a status-dashboard plan — an active group OR an active app
 * (ADR-145 D4). Manifest data only: the caller serves it to the page, which asks every probe
 * itself in the viewer's own session. The caller is responsible for passing only the manifests
 * this viewer may see, so an unknown, inactive or invisible name is indistinguishable from
 * not-found and answers `null`.
 * @param name - The manifest name from the route.
 * @param activeManifests - The ACTIVE manifests this caller may see.
 * @returns The plan, or null when the name is not one of them.
 */
export function getAppStatusPlan(
  name: string,
  activeManifests: readonly SwarmAppManifest[],
): AppStatusPlan | null {
  const byName = new Map(activeManifests.map((manifest) => [manifest.name, manifest]));
  const manifest = byName.get(name);
  if (!manifest) return null;
  return isGroupManifest(manifest) ? groupPlan(manifest, byName) : appPlan(manifest);
}
