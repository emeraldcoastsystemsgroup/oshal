/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-141 application groups. A `kind: group` manifest carries NO code and binds installed member apps into one front door: its `toolbar[]` BORROWS member surfaces by app + surface name (a reference the loader resolves — never a copied URL, so a renamed surface fails the group instead of leaving a dead tile), its `setup[]` drives the ONE kernel setup dashboard from the members' per-user `readiness:` probes (the session-authenticated sibling of `smoke:`). Static validation (loader) and resolution against the active members (service: fail-closed at activation, lenient-with-warning at profile synthesis) both live here so the service stays under its size budget.
 */

import fs from 'fs';
import yaml from 'js-yaml';
import { resolveRouteAuthMode } from '@/shared/route-auth';
import type {
  SwarmAppGroupSetupStep,
  SwarmAppGroupToolbarEntry,
  SwarmAppManifest,
  SwarmAppReadinessDeclaration,
  SwarmAppStaticUi,
} from '../types';

/** The closed manifest-kind vocabulary (ADR-141 D1). */
export const SWARM_APP_KINDS = ['app', 'group'] as const;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Keys a group may never declare — composition is its whole job (ADR-141 D1). */
const GROUP_FORBIDDEN_KEYS = [
  'bots', 'foundation', 'tools', 'toolsDir', 'routes', 'migrations', 'schedules', 'workflow',
  'ticketType', 'takeout', 'smoke', 'readiness', 'ui', 'skillProfiles', 'uses', 'artifacts',
  'surface', 'ragCollections', 'chatBot',
] as const;

/** Route auth modes that admit a browser session — the only ones a readiness probe may sit behind. */
const SESSION_ADMITTING_MODES = new Set(['oidc', 'service-or-oidc']);

/** Thrown when a group names a member, surface or readiness that the active members do not provide. */
export class GroupResolutionError extends Error {
  constructor(public readonly group: string, public readonly problems: string[]) {
    super(`Group "${group}" cannot activate: ${problems.join('; ')}`);
    this.name = 'GroupResolutionError';
  }
}

/** One dashboard step after resolution: a probe when the member provides it, else why not. */
export interface ResolvedGroupSetupStep {
  label: string;
  app: string;
  appDisplayName: string;
  readiness: string;
  /** The ribbon surface (`ui.static[].toolName`) the dashboard opens for this step. */
  fix?: string;
  probe?: { path: string; readyPointer: string; detailPointer?: string };
  /** Present when the step cannot be probed: the member is not active, or declares no such readiness. */
  unavailable?: string;
}

/** The toolbar after resolution: borrowed tiles plus every reference that did not resolve. */
export interface ResolvedGroupToolbar {
  tiles: SwarmAppStaticUi[];
  missing: Array<{ app: string; surface: string; reason: string }>;
}

/**
 * @description Whether a manifest is an ADR-141 group (a code-less binding of member apps).
 * @param manifest - Any manifest.
 * @returns True for `kind: group`.
 */
export function isGroupManifest(manifest: Pick<SwarmAppManifest, 'kind'>): boolean {
  return manifest.kind === 'group';
}

/**
 * @description Boot order for auto-load: every app first, every group last, so a group's members
 * are already active when it activates. Peeks `kind:` from the YAML text without validating —
 * unreadable or unparsable files keep their place (the loader reports them properly later).
 * @param manifestFiles - Manifest paths in directory order.
 * @returns The same paths, groups moved to the end (relative order otherwise preserved).
 */
export function orderGroupsLast(manifestFiles: string[]): string[] {
  const isGroupFile = (file: string): boolean => {
    try {
      const parsed = yaml.load(fs.readFileSync(file, 'utf-8')) as { kind?: unknown } | null;
      return !!parsed && typeof parsed === 'object' && parsed.kind === 'group';
    } catch {
      return false;
    }
  };
  const groups: string[] = [];
  const apps: string[] = [];
  for (const file of manifestFiles) (isGroupFile(file) ? groups : apps).push(file);
  return [...apps, ...groups];
}

/**
 * @description The kernel-rendered setup dashboard tile every group gets first (ADR-141 D4).
 * @param groupName - The group's manifest name.
 * @returns A static-UI entry pointing at the shared dashboard surface for this group.
 */
export function groupDashboardTile(groupName: string): SwarmAppStaticUi {
  return {
    toolName: `${groupName}-setup`,
    label: 'Setup',
    icon: 'codicon codicon-checklist',
    iframeUrl: `/api/swarm/apps/${encodeURIComponent(groupName)}/setup-dashboard?group=${encodeURIComponent(groupName)}`,
    section: 'top',
  };
}

/**
 * @description The ribbon items synthesiseProfile emits for a list of static surfaces. Ids carry
 * the `tool-` prefix the cockpit view controller routes to renderToolView; `group` rides through
 * verbatim (RibbonNav decides where a heading is allowed).
 * @param surfaces - Static UI entries (an app's own, or a group's borrowed ones).
 * @returns Ribbon items in declaration order.
 */
export function staticRibbonItems(surfaces: SwarmAppStaticUi[]): Array<{
  id: string; icon: string; label: string; section: 'top' | 'bottom'; group?: string;
  toolUi: { iframeUrl: string; sidebarLabel: string };
}> {
  return surfaces.map((s) => ({
    id: `tool-${s.toolName}`,
    icon: s.icon,
    label: s.label,
    section: (s.section === 'bottom' ? 'bottom' : 'top') as 'top' | 'bottom',
    group: s.group,
    toolUi: { iframeUrl: s.iframeUrl, sidebarLabel: s.label },
  }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCanonicalPath(value: unknown): value is string {
  return typeof value === 'string'
    && /^\/(?!\/)/.test(value)
    && !/[?#\\\s]/.test(value)
    && !value.includes('//')
    && !value.split('/').some((segment) => segment === '.' || segment === '..')
    && !/%(?:2e|2f|5c)/i.test(value);
}

function isJsonPointer(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !/~(?![01])/.test(value);
}

function memberNames(manifest: SwarmAppManifest, absPath: string): string[] {
  const members = manifest.dependencies?.apps;
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error(`Manifest ${absPath}: a group must list its member apps under dependencies.apps (non-empty)`);
  }
  const seen = new Set<string>();
  for (const m of members) {
    if (typeof m !== 'string' || !SLUG.test(m)) throw new Error(`Manifest ${absPath}: dependencies.apps entries must be package slugs`);
    if (m === manifest.name) throw new Error(`Manifest ${absPath}: a group cannot be its own member`);
    if (seen.has(m)) throw new Error(`Manifest ${absPath}: dependencies.apps repeats "${m}"`);
    seen.add(m);
  }
  return members;
}

function validateToolbar(manifest: SwarmAppManifest, absPath: string, members: Set<string>): Set<string> {
  const toolbar = manifest.toolbar;
  if (!Array.isArray(toolbar) || toolbar.length === 0) {
    throw new Error(`Manifest ${absPath}: a group must declare a non-empty toolbar[] of borrowed member surfaces`);
  }
  const surfaces = new Set<string>();
  const seen = new Set<string>();
  for (const [index, value] of toolbar.entries()) {
    const at = `toolbar[${index}]`;
    if (!isPlainObject(value)) throw new Error(`Manifest ${absPath}: ${at} must be an object {app, surface, group?, section?}`);
    const unknown = Object.keys(value).filter((k) => !['app', 'surface', 'group', 'section'].includes(k));
    if (unknown.length) throw new Error(`Manifest ${absPath}: ${at} has unknown field(s): ${unknown.join(', ')} — a tile is BORROWED by reference; label/icon/iframeUrl come from the member`);
    const entry = value as unknown as SwarmAppGroupToolbarEntry;
    if (typeof entry.app !== 'string' || !members.has(entry.app)) {
      throw new Error(`Manifest ${absPath}: ${at}.app "${String(entry.app)}" is not a member (dependencies.apps: ${[...members].join(', ')})`);
    }
    if (typeof entry.surface !== 'string' || !SLUG.test(entry.surface)) throw new Error(`Manifest ${absPath}: ${at}.surface must be a surface slug (the member's ui.static[].toolName)`);
    if (entry.group !== undefined && (typeof entry.group !== 'string' || !entry.group.trim())) throw new Error(`Manifest ${absPath}: ${at}.group, when present, must be a non-empty label`);
    if (entry.section !== undefined && entry.section !== 'top' && entry.section !== 'bottom') throw new Error(`Manifest ${absPath}: ${at}.section must be top or bottom`);
    const key = `${entry.app}/${entry.surface}`;
    if (seen.has(key)) throw new Error(`Manifest ${absPath}: ${at} repeats ${key}`);
    seen.add(key);
    surfaces.add(entry.surface);
  }
  return surfaces;
}

function validateSetup(manifest: SwarmAppManifest, absPath: string, members: Set<string>, surfaces: Set<string>): void {
  const setup = manifest.setup;
  if (setup === undefined) return;
  if (!Array.isArray(setup) || setup.length === 0) throw new Error(`Manifest ${absPath}: setup, when present, must be a non-empty array of steps`);
  const seen = new Set<string>();
  for (const [index, value] of setup.entries()) {
    const at = `setup[${index}]`;
    if (!isPlainObject(value)) throw new Error(`Manifest ${absPath}: ${at} must be an object {label, app, readiness, fix?}`);
    const unknown = Object.keys(value).filter((k) => !['label', 'app', 'readiness', 'fix'].includes(k));
    if (unknown.length) throw new Error(`Manifest ${absPath}: ${at} has unknown field(s): ${unknown.join(', ')}`);
    const step = value as unknown as SwarmAppGroupSetupStep;
    if (typeof step.label !== 'string' || !step.label.trim()) throw new Error(`Manifest ${absPath}: ${at}.label must be a non-empty string`);
    if (typeof step.app !== 'string' || !members.has(step.app)) throw new Error(`Manifest ${absPath}: ${at}.app "${String(step.app)}" is not a member`);
    if (typeof step.readiness !== 'string' || !SLUG.test(step.readiness)) throw new Error(`Manifest ${absPath}: ${at}.readiness must name a readiness slug the member declares`);
    if (step.fix !== undefined && (typeof step.fix !== 'string' || !surfaces.has(step.fix))) {
      throw new Error(`Manifest ${absPath}: ${at}.fix "${String(step.fix)}" must name a toolbar surface, so the dashboard can open it inside this group`);
    }
    const key = `${step.app}/${step.readiness}`;
    if (seen.has(key)) throw new Error(`Manifest ${absPath}: ${at} repeats ${key}`);
    seen.add(key);
  }
}

/**
 * @description Fail-closed static validation of the ADR-141 group keys. For `kind: group`: no code
 * key may be present, members are required, the toolbar borrows only from members, and every setup
 * step names a member plus a toolbar surface to open. For an ordinary app: the group-only keys must
 * be absent (a `toolbar:` on an app would sit there looking meaningful and do nothing).
 * @param manifest - The parsed manifest.
 * @param absPath - Its path, for the error message.
 */
export function validateGroupManifest(manifest: SwarmAppManifest, absPath: string): void {
  if (manifest.kind !== undefined && !(SWARM_APP_KINDS as readonly string[]).includes(manifest.kind as string)) {
    throw new Error(`Manifest ${absPath}: kind must be one of ${SWARM_APP_KINDS.join(', ')} (got "${String(manifest.kind)}")`);
  }
  if (!isGroupManifest(manifest)) {
    const groupOnly = ['toolbar', 'setup'].filter((k) => (manifest as unknown as Record<string, unknown>)[k] !== undefined);
    if (groupOnly.length) {
      throw new Error(`Manifest ${absPath}: ${groupOnly.join(', ')} are group-only keys — declare kind: group, or remove them (an app's tiles are its own ui.static)`);
    }
    return;
  }
  const present = GROUP_FORBIDDEN_KEYS.filter((k) => (manifest as unknown as Record<string, unknown>)[k] !== undefined);
  if (present.length) {
    throw new Error(`Manifest ${absPath}: a group carries no code — remove ${present.join(', ')}. A group binds installed apps (dependencies.apps) and borrows their surfaces (toolbar); anything that executes belongs in a member package.`);
  }
  const members = new Set(memberNames(manifest, absPath));
  const surfaces = validateToolbar(manifest, absPath, members);
  validateSetup(manifest, absPath, members, surfaces);
}

/**
 * @description Fail-closed validation of a package's `readiness[]` block (ADR-141 D3) — the same
 * discipline as `smoke:`: canonical path below one of the package's OWN routes, valid RFC 6901
 * pointers, and — because the dashboard asks in the signed-in user's session — an owning route
 * that admits a browser session (`oidc` or `service-or-oidc`; never service-only, operator or public).
 * @param manifest - The parsed manifest.
 * @param absPath - Its path, for the error message.
 */
export function validateReadinessDeclarations(manifest: SwarmAppManifest, absPath: string): void {
  if (manifest.readiness === undefined) return;
  if (!Array.isArray(manifest.readiness) || manifest.readiness.length === 0) {
    throw new Error(`Manifest ${absPath}: readiness, when present, must be a non-empty array`);
  }
  const routes = manifest.routes ?? [];
  const names = new Set<string>();
  for (const [index, value] of manifest.readiness.entries()) {
    const at = `readiness[${index}]`;
    if (!isPlainObject(value)) throw new Error(`Manifest ${absPath}: ${at} must be an object {name, path, readyPointer, detailPointer?}`);
    const unknown = Object.keys(value).filter((k) => !['name', 'path', 'readyPointer', 'detailPointer'].includes(k));
    if (unknown.length) throw new Error(`Manifest ${absPath}: ${at} has unknown field(s): ${unknown.join(', ')}`);
    const decl = value as unknown as SwarmAppReadinessDeclaration;
    if (typeof decl.name !== 'string' || !SLUG.test(decl.name)) throw new Error(`Manifest ${absPath}: ${at}.name must be a lowercase slug`);
    if (names.has(decl.name)) throw new Error(`Manifest ${absPath}: duplicate readiness name "${decl.name}"`);
    names.add(decl.name);
    if (!isCanonicalPath(decl.path)) throw new Error(`Manifest ${absPath}: ${at}.path must be a concrete canonical root-relative path`);
    const owner = routes
      .filter((route) => decl.path === route.mountPath.replace(/\/+$/, '') || decl.path.startsWith(`${route.mountPath.replace(/\/+$/, '')}/`))
      .sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
    if (!owner) throw new Error(`Manifest ${absPath}: ${at}.path "${decl.path}" is not owned by a declared routes[].mountPath — readiness is a fact this package proves about its OWN store`);
    const mode = resolveRouteAuthMode(owner);
    if (!SESSION_ADMITTING_MODES.has(mode)) {
      throw new Error(`Manifest ${absPath}: ${at}.path is owned by ${owner.mountPath} (auth: ${mode}) — a readiness probe runs AS THE SIGNED-IN USER, so its route must admit a browser session (oidc or service-or-oidc)`);
    }
    if (!isJsonPointer(decl.readyPointer) || decl.readyPointer === '') throw new Error(`Manifest ${absPath}: ${at}.readyPointer must be a non-empty RFC 6901 pointer`);
    if (decl.detailPointer !== undefined && !isJsonPointer(decl.detailPointer)) throw new Error(`Manifest ${absPath}: ${at}.detailPointer, when present, must be an RFC 6901 pointer`);
  }
}

/**
 * @description Resolves a group's toolbar against the ACTIVE member manifests. Each entry becomes a
 * copy of the member's own surface (label, icon, iframeUrl) with the group's band/section applied;
 * references that do not resolve are returned under `missing` with the reason, never as a tile.
 * @param group - The group manifest.
 * @param members - Active member manifests keyed by name (an inactive member is simply absent).
 * @returns Borrowed tiles in toolbar order, plus every unresolved reference.
 */
export function resolveGroupToolbar(group: SwarmAppManifest, members: ReadonlyMap<string, SwarmAppManifest>): ResolvedGroupToolbar {
  const tiles: SwarmAppStaticUi[] = [];
  const missing: ResolvedGroupToolbar['missing'] = [];
  for (const entry of group.toolbar ?? []) {
    const member = members.get(entry.app);
    if (!member) { missing.push({ app: entry.app, surface: entry.surface, reason: `member app "${entry.app}" is not installed and active` }); continue; }
    const surface = (member.ui?.static ?? []).find((s) => s.toolName === entry.surface);
    if (!surface) {
      const has = (member.ui?.static ?? []).map((s) => s.toolName).join(', ') || '(none)';
      missing.push({ app: entry.app, surface: entry.surface, reason: `member "${entry.app}" declares no surface "${entry.surface}" (it has: ${has})` });
      continue;
    }
    tiles.push({
      toolName: surface.toolName,
      label: surface.label,
      icon: surface.icon,
      iframeUrl: surface.iframeUrl,
      section: entry.section ?? 'top',
      ...(entry.group !== undefined ? { group: entry.group } : {}),
    });
  }
  return { tiles, missing };
}

/**
 * @description Resolves a group's setup steps against the ACTIVE member manifests. A step whose
 * member is active and declares the named readiness carries its probe; otherwise it carries the
 * reason under `unavailable` — the dashboard renders that as such, never as done.
 * @param group - The group manifest.
 * @param members - Active member manifests keyed by name.
 * @returns Steps in declaration order.
 */
export function resolveGroupSetup(group: SwarmAppManifest, members: ReadonlyMap<string, SwarmAppManifest>): ResolvedGroupSetupStep[] {
  return (group.setup ?? []).map((step) => {
    const member = members.get(step.app);
    const base = { label: step.label, app: step.app, appDisplayName: member?.displayName ?? step.app, readiness: step.readiness, ...(step.fix ? { fix: step.fix } : {}) };
    if (!member) return { ...base, unavailable: `member app "${step.app}" is not installed and active` };
    const decl = (member.readiness ?? []).find((r) => r.name === step.readiness);
    if (!decl) return { ...base, unavailable: `member "${step.app}" declares no readiness "${step.readiness}"` };
    return { ...base, probe: { path: decl.path, readyPointer: decl.readyPointer, ...(decl.detailPointer ? { detailPointer: decl.detailPointer } : {}) } };
  });
}

/**
 * @description The fail-closed activation check (ADR-141 D2/D3): every toolbar reference and every
 * setup step must resolve against the active members, or the group does not activate — with the
 * member and surface/readiness named in the error.
 * @param group - The group manifest.
 * @param members - Active member manifests keyed by name.
 * @throws GroupResolutionError listing every unresolved reference.
 */
export function assertGroupResolvable(group: SwarmAppManifest, members: ReadonlyMap<string, SwarmAppManifest>): void {
  const problems = [
    ...resolveGroupToolbar(group, members).missing.map((m) => `toolbar ${m.app}/${m.surface}: ${m.reason}`),
    ...resolveGroupSetup(group, members).filter((s) => s.unavailable).map((s) => `setup "${s.label}": ${s.unavailable}`),
  ];
  if (problems.length) throw new GroupResolutionError(group.name, problems);
}
