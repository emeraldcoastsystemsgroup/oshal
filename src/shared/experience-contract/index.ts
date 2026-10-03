/**
 * CHANGE LOG
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-164: validate experience declarations before installation; the hosting compatibility floor stays unavailable until hosting and discovery ship.
 */
import { readAppDependencies, type AppDependencySource } from '@/shared/app-dependencies';

/** Compatibility floor; register it only with the completed hosting implementation. */
export const EXPERIENCE_SKILL = 'experience';

/** A supported member surface; identity is independent of a member's internal URL or DOM. */
export interface ExperienceSurface {
  app: string;
  surface: string;
  audience?: 'family' | 'classroom' | 'company';
}

/** Version one of the approved package-owned presentation declaration. */
export interface ExperienceDeclaration {
  version: 1;
  entry: string;
  shell: 'page' | 'rail';
  skin: string;
  label: string;
  surfaces?: ExperienceSurface[];
}

/** Structural input keeps this contract independent of the feature-layer manifest type. */
export interface ExperienceManifestSource extends AppDependencySource {
  experience?: unknown;
  authorization?: { version?: unknown; catalog?: unknown };
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

/**
 * Validate the package declaration without granting access or resolving member catalogs.
 * Cross-package surface existence is checked at activation, against active member manifests.
 * The loader independently checks that the hosting skill is actually implemented on this core.
 */
export function validateExperienceDeclaration(manifest: ExperienceManifestSource): void {
  if (manifest.experience === undefined) return;
  const e = object(manifest.experience, ['version', 'entry', 'shell', 'skin', 'label', 'surfaces'], 'experience');
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
  if (!canonicalPath(e.entry)) throw new Error('experience.entry must be a canonical root-relative document path');
  const routes = Array.isArray(manifest.routes) ? manifest.routes : [];
  const owners = routes.filter(route => typeof route.mountPath === 'string'
    && canonicalPath(route.mountPath)
    && (e.entry === route.mountPath || (e.entry as string).startsWith(`${route.mountPath}/`)));
  // Match the mounter's ordering conservatively: every matching mount must admit a session
  // and refuse anonymous entry, so an earlier public mount cannot intercept this document.
  if (!owners.length || owners.some(route => !['oidc', 'service-or-oidc'].includes(String(route.auth))
    || route.allowAnonymous === true)) {
    throw new Error('experience.entry must belong to a declared session-authenticated package route');
  }
  const dependencies = readAppDependencies(manifest);
  const members = new Set([...dependencies.required.apps, ...dependencies.optional.apps]);
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
