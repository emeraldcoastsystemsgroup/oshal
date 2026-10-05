/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-164: validate experience declarations before installation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Resolve named member surfaces against active manifests without coupling packages to member URLs or markup.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Declare bounded versioned role templates with explicit member role identities; optional members require deliberate selection at assignment time.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Validate native application composites through the shared CLI/runtime template contract without requiring a presentation shell.
 */
import { readAppDependencies, type AppDependencySource } from '@/shared/app-dependencies';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const roleContract = createRequire(__filename)(resolve(__dirname, '../../../scripts/oshal-role-templates.js')) as {
  validateRoleTemplates(name: unknown, value: unknown, required: string[], dependencies: Set<string>): void;
  validateAuthorizationRoleTemplates(manifest: ExperienceManifestSource): void;
};

/** Compatibility floor for package discovery, shell hosting and supported member surfaces. */
export const EXPERIENCE_SKILL = 'experience';
/** Advertised only when the complete reviewed composite lifecycle is implemented. */
export const EXPERIENCE_ROLES_SKILL = 'experience-roles';

/** A supported member surface; identity is independent of a member's internal URL or DOM. */
export interface ExperienceSurface {
  app: string;
  surface: string;
  audience?: 'family' | 'classroom' | 'company';
}

/** Catalog role IDs, never display tiers or permission guesses. A declaration grants nothing. */
export interface ExperienceRoleTemplate {
  id: string;
  version: number;
  label: string;
  members: Array<{ app: string; role: string }>;
}

/** Version one of the approved package-owned presentation declaration. */
export interface ExperienceDeclaration {
  version: 1;
  entry: string;
  shell: 'page' | 'rail';
  skin: string;
  label: string;
  surfaces?: ExperienceSurface[];
  roleTemplates?: ExperienceRoleTemplate[];
}

/** Structural input keeps this contract independent of the feature-layer manifest type. */
export interface ExperienceManifestSource extends AppDependencySource {
  experience?: unknown;
  authorization?: { version?: unknown; catalog?: unknown; roleTemplates?: unknown };
  routes?: Array<{ mountPath?: unknown; auth?: unknown; allowAnonymous?: unknown }>;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SURFACE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/** Refuse unknown keys instead of accepting declarations the runtime would ignore. */
function object(value: unknown, keys: string[], at: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at} must be an object`);
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).filter(key => !keys.includes(key));
  if (unknown.length) throw new Error(`${at} has unknown fields: ${unknown.join(', ')}`);
  return result;
}

/** A canonical document path, with no browser normalization or encoded-separator surprises. */
function canonicalPath(value: unknown): value is string {
  return typeof value === 'string' && /^\/[a-zA-Z0-9_./-]+$/.test(value)
    && !value.includes('//') && !value.endsWith('/')
    && value.split('/').every(part => part !== '.' && part !== '..');
}

/** Require a canonical experience entry under its existing session-authenticated package mounts. */
function validateAuthenticatedEntry(manifest: ExperienceManifestSource, entry: unknown): void {
  if (!canonicalPath(entry)) throw new Error('experience.entry must be a canonical root-relative document path');
  const routes = Array.isArray(manifest.routes) ? manifest.routes : [];
  const owners = routes.filter(route => typeof route.mountPath === 'string' && canonicalPath(route.mountPath)
    && (entry === route.mountPath || entry.startsWith(`${route.mountPath}/`)));
  // Every matching mount must refuse anonymous entry, including any earlier intercepting mount.
  if (!owners.length || owners.some(route => !['oidc', 'service-or-oidc'].includes(String(route.auth)) || route.allowAnonymous === true)) {
    throw new Error('experience.entry must belong to a declared session-authenticated package route');
  }
}

/**
 * @description Validate the package declaration without granting access or resolving member catalogs.
 * Cross-package surface existence is checked at activation, against active member manifests.
 * The loader independently checks that the hosting skill is implemented on this core.
 * @param manifest Untrusted structural manifest input.
 * @returns Nothing; invalid declarations throw before installation.
 */
export function validateExperienceDeclaration(manifest: ExperienceManifestSource): void {
  roleContract.validateAuthorizationRoleTemplates(manifest);
  if (manifest.experience === undefined) return;
  const e = object(manifest.experience, ['version', 'entry', 'shell', 'skin', 'label', 'surfaces', 'roleTemplates'], 'experience');
  if (manifest.kind === 'group') throw new Error('experience must be an ordinary application, not a code-free group');
  if (!Array.isArray(manifest.uses) || !manifest.uses.includes(EXPERIENCE_SKILL)
    || !manifest.uses.includes('application-authorization')) {
    throw new Error('experience requires uses: [application-authorization, experience]');
  }
  if (e.version !== 1) throw new Error('experience.version must be 1');
  if (e.shell !== 'page' && e.shell !== 'rail') throw new Error('experience.shell must be page or rail');
  if (typeof e.skin !== 'string' || !SLUG.test(e.skin)) throw new Error('experience.skin must be a theme slug');
  if (typeof e.label !== 'string' || !e.label.trim() || e.label.length > 128 || /[\x00-\x1f\x7f]/.test(e.label)) {
    throw new Error('experience.label must be 1..128 characters without control characters');
  }
  if (manifest.authorization?.version !== 1 || typeof manifest.authorization.catalog !== 'string'
    || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.ya?ml$/.test(manifest.authorization.catalog)) {
    throw new Error('experience requires a version 1 package-local authorization catalog');
  }
  validateAuthenticatedEntry(manifest, e.entry);
  const dependencies = readAppDependencies(manifest);
  const members = new Set([...dependencies.required.apps, ...dependencies.optional.apps]);
  if (e.roleTemplates !== undefined && !manifest.uses.includes(EXPERIENCE_ROLES_SKILL)) {
    throw new Error('experience role templates require uses: [experience-roles]');
  }
  validateRoleTemplates(manifest.name, e.roleTemplates, dependencies.required.apps, members);
  if (e.surfaces === undefined) return;
  if (!Array.isArray(e.surfaces) || e.surfaces.length > 128) throw new Error('experience.surfaces must be an array of at most 128 references');
  const seen = new Set<string>();
  for (const value of e.surfaces) {
    const ref = object(value, ['app', 'surface', 'audience'], 'experience.surfaces[]');
    if (typeof ref.app !== 'string' || !SLUG.test(ref.app) || !members.has(ref.app)) {
      throw new Error('experience surface app must name a declared required or optional dependency');
    }
    if (typeof ref.surface !== 'string' || !SURFACE.test(ref.surface)) throw new Error('experience surface must name a supported surface identifier');
    if (ref.audience !== undefined && !['family', 'classroom', 'company'].includes(String(ref.audience))) {
      throw new Error('experience surface audience must be family, classroom or company');
    }
    const key = `${ref.app}\0${ref.surface}`;
    if (seen.has(key)) throw new Error('experience surfaces must not repeat an app/surface reference');
    seen.add(key);
  }
}

/** @description Validate references now; the authority resolves exact installed roles at review.
 * @param name Host package name. @param value Untrusted templates. @param required Required members.
 * @param dependencies All declared members. @returns Nothing; invalid declarations throw. */
export function validateRoleTemplates(name: unknown, value: unknown, required: string[], dependencies: Set<string>): void {
  roleContract.validateRoleTemplates(name, value, required, dependencies);
}

/**
 * @description Resolve current named member surfaces, preserving supported query, fragment and original visibility identity.
 * @param manifest Validated experience package declaration.
 * @param members Currently active member manifests.
 * @returns Resolved supported surfaces and optional unavailability reasons; missing required surfaces throw.
 */
export function resolveExperienceSurfaces<T extends { toolName: string; iframeUrl: string }>(
  manifest: ExperienceManifestSource,
  members: ReadonlyMap<string, { ui?: { static?: T[] } }>,
): { surfaces: Array<T & { visibilityToolName: string }>; unavailable: Array<ExperienceSurface & { reason: string }> } {
  const experience = manifest.experience as ExperienceDeclaration | undefined;
  if (!experience) return { surfaces: [], unavailable: [] };
  const required = new Set(readAppDependencies(manifest).required.apps);
  const surfaces: Array<T & { visibilityToolName: string }> = [], unavailable: Array<ExperienceSurface & { reason: string }> = [];
  for (const ref of experience.surfaces ?? []) {
    const member = members.get(ref.app);
    const surface = member?.ui?.static?.find(candidate => candidate.toolName === ref.surface);
    if (!surface) {
      if (required.has(ref.app)) throw new Error(`experience required surface unavailable: ${ref.app}/${ref.surface}`);
      unavailable.push({ ...ref, reason: member ? 'surface-unavailable' : 'application-unavailable' });
      continue;
    }
    const local = new URL(surface.iframeUrl, 'https://experience.invalid');
    if (local.origin !== 'https://experience.invalid' || !surface.iframeUrl.startsWith('/')
      || local.pathname.startsWith('//')) throw new Error(`experience member surface must be same-origin: ${ref.app}/${ref.surface}`);
    if (ref.audience && !local.searchParams.has('audience')) local.searchParams.set('audience', ref.audience);
    // Identity includes its owner: different member apps may have equally named surfaces.
    surfaces.push({ ...surface, toolName: `${ref.app}--${surface.toolName}`, visibilityToolName: surface.toolName,
      iframeUrl: `${local.pathname}${local.search}${local.hash}` });
  }
  return { surfaces, unavailable };
}
