/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial YAML loader for swarm app manifests
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085: listManifestFiles also discovers PACKAGE folders — <dir>/<name>/oshal-app.yaml (one level deep) — so store-installed apps in deployed-apps/ auto-load at boot alongside flat *.yaml manifests.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 D8: validate the new `uses:` (kernel skills) fail-closed — an unknown skill id fails at load instead of crashing the app at mount, where the missing module is far harder to diagnose.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D9/D12: fail closed on a ui.assistant iframeUrl that is not same-origin + root-relative (an absolute, protocol-relative or javascript: URL would turn the declarative widget back into the arbitrary-code channel it exists to avoid); WARN on the inert toolsDir field — nothing in core consumes it, so bundled tool JS is not callable, and it is removed next store release.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-097: validate manifest.suite — value fail-closed (a typo must not invent a catalog shelf), presence warn-only (pre-097 store installs keep booting; the warn is the upgrade prompt).
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 addendum: validate manifest.skillProfiles — fail-closed on the map shape, unknown capability keys (isSkillCapabilityId), and stub profiles (pattern + instructions must be non-empty). Sits next to the uses: block — the two kernel-capability validations read together.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Validate manifest.surface.ops fail-closed against the shared surface-bridge vocabulary (@/shared/surface-bridge-ops) — a typo'd op must fail at load, not silently never relay; absence stays legal (= no ops relayed, the fail-closed default).
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Validate packaged-bot harness and API declarations as complete compatible pairs before activation.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: fail manifest load on malformed access blocks, unknown/duplicate tiers, missing deny, unsupported defaults, and invalid capability mappings.
 * 10 | maintainer@emeraldcoastsystemsgroup.com  | INSTALLER-GAPS CORE-05: validate package-owned smoke probes, confined JSON fixtures, route ownership, and explicit AI-route metadata.
 * 11 | maintainer@emeraldcoastsystemsgroup.com  | Validate manifest-contributed Takeout slices fail-closed: literal canonical suffixes only, confined compiled modules, bounded uncompressed bytes, unique stable ids/paths, and named handler exports.
 * 12 | maintainer@emeraldcoastsystemsgroup.com  | Validate both manifest schedule modes fail-closed. Deterministic service-route jobs must be framework-scoped static POSTs beneath an exactly service-authenticated package route; malformed cron, mixed prompt/route fields, dynamic interpolation, and oversized bodies are rejected at load.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { CronExpressionParser } from 'cron-parser';
import { createChildLogger } from '@/shared/logger';
import { KERNEL_SKILL_IDS, isKernelSkillId } from '@/shared/kernel-skills';
import { SKILL_CAPABILITY_IDS, isSkillCapabilityId } from '@/shared/skill-profiles';
import { SWARM_ACCESS_ROLES, isSwarmAccessRole } from '@/shared/types/access-roles';
import { GUEST_TIERS, isGuestTier } from '@/shared/middleware/guest-capability-matrix';
import { SURFACE_BRIDGE_OPS, isSurfaceBridgeOp } from '@/shared/surface-bridge-ops';
import { ApiProviderSchema } from '@/shared/types/api-provider';
import {
  ROUTE_AUTH_MODES,
  isRouteAuthMode,
  resolveRouteAuthMode,
  routeAuthContradicts,
  type SwarmAppRouteAuthMode,
} from '@/shared/route-auth';
import {
  SWARM_APP_BOT_HARNESS_TYPES,
  SWARM_APP_BOT_SPECIAL_API_TYPES,
  SWARM_APP_SUITES,
  APP_ACCESS_TIERS,
  isAppAccessTier,
  isSwarmAppSuite,
  type SwarmAppBotDeclaration,
  type SwarmAppBotHarnessType,
  type SwarmAppManifest,
} from '../types';

const logger = createChildLogger({ module: 'swarm-app-loader' });

/** Minimum required manifest fields. Validation is defensive — malformed
 *  files must fail fast so broken manifests can't brick the boot path.
 *  `bots` is NOT required: a deterministic / UI-only app (e.g. payments, which
 *  charges on a brokered merchant token with no LLM) legitimately declares none. */
const REQUIRED_FIELDS: Array<keyof SwarmAppManifest> = ['name', 'displayName'];

const FIXED_BOT_API_TYPES: Partial<Record<SwarmAppBotHarnessType, readonly string[]>> = {
  'codex-cli': ['openai', 'openai-codex'],
  'claude-code': ['claude-code'],
  'gemini-cli': ['google-gemini'],
  a2a: ['a2a'],
  noop: ['noop'],
};

const SMOKE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const SMOKE_AUTH_MODES = ['service', 'pat', 'public'] as const;
const MAX_SMOKE_FIXTURE_BYTES = 64 * 1024;
const DEFAULT_TAKEOUT_SLICE_BYTES = 64 * 1024 * 1024;
const MAX_TAKEOUT_SLICE_BYTES = 128 * 1024 * 1024;
const MAX_SERVICE_SCHEDULE_BODY_BYTES = 16 * 1024;
const MAX_SERVICE_SCHEDULE_JSON_DEPTH = 8;
const MAX_SERVICE_SCHEDULE_JSON_ENTRIES = 256;

/** @description Validate the complete ADR-118 access declaration at the trust boundary. */
function validateAppAccess(manifest: SwarmAppManifest, absPath: string): void {
  if (manifest.access === undefined) return; // opt-in rollout: absence preserves current behavior
  const access = manifest.access as unknown;
  if (!access || typeof access !== 'object' || Array.isArray(access)) {
    throw new Error(`Manifest ${absPath}: access must be an object`);
  }
  const record = access as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter(
    (key) => !['supported', 'defaultTier', 'mappings'].includes(key),
  );
  if (unknownFields.length > 0) {
    throw new Error(`Manifest ${absPath}: access has unknown field(s): ${unknownFields.join(', ')}`);
  }
  if (!Array.isArray(record.supported) || record.supported.length === 0) {
    throw new Error(`Manifest ${absPath}: access.supported must be a non-empty tier array`);
  }
  const supported = record.supported;
  const unknownTiers = supported.filter((tier) => !isAppAccessTier(tier));
  if (unknownTiers.length > 0) {
    throw new Error(
      `Manifest ${absPath}: access.supported contains unknown tier(s): ${unknownTiers.join(', ')}. ` +
        `Known tiers: ${APP_ACCESS_TIERS.join(', ')}`,
    );
  }
  if (new Set(supported).size !== supported.length) {
    throw new Error(`Manifest ${absPath}: access.supported must not contain duplicate tiers`);
  }
  if (!supported.includes('deny')) {
    throw new Error(`Manifest ${absPath}: access.supported must include deny (explicit deny is universal)`);
  }
  if (!isAppAccessTier(record.defaultTier)) {
    throw new Error(
      `Manifest ${absPath}: access.defaultTier is unknown. Known tiers: ${APP_ACCESS_TIERS.join(', ')}`,
    );
  }
  if (!supported.includes(record.defaultTier)) {
    throw new Error(`Manifest ${absPath}: access.defaultTier must also appear in access.supported`);
  }
  if (record.mappings !== undefined) {
    if (!record.mappings || typeof record.mappings !== 'object' || Array.isArray(record.mappings)) {
      throw new Error(`Manifest ${absPath}: access.mappings must be an object when present`);
    }
    for (const [tier, bundle] of Object.entries(record.mappings as Record<string, unknown>)) {
      if (!isAppAccessTier(tier)) {
        throw new Error(`Manifest ${absPath}: access.mappings contains unknown tier: ${tier}`);
      }
      if (!supported.includes(tier)) {
        throw new Error(`Manifest ${absPath}: access.mappings.${tier} maps a tier the app does not support`);
      }
      if (typeof bundle !== 'string' || !bundle.trim()) {
        throw new Error(`Manifest ${absPath}: access.mappings.${tier} must be a non-empty bundle id`);
      }
    }
  }
}

/** @description Whether a provider id is accepted at the packaged-bot boundary. */
function isKnownBotApiType(value: string): boolean {
  return ApiProviderSchema.safeParse(value).success
    || (SWARM_APP_BOT_SPECIAL_API_TYPES as readonly string[]).includes(value);
}

/** @description Fail closed on incomplete, unknown, or incompatible bot runtime declarations. */
function validateBotRuntime(bot: SwarmAppBotDeclaration, index: number, absPath: string): void {
  const at = `bots[${index}] (${bot && bot.name || '?'})`;
  const harness = bot && bot.harnessType, api = bot && bot.apiType;
  if (harness === undefined && api === undefined) return;
  if (typeof harness !== 'string' || typeof api !== 'string' || !harness || !api) {
    throw new Error(`Manifest ${absPath}: ${at} must declare harnessType and apiType together.`);
  }
  if (!(SWARM_APP_BOT_HARNESS_TYPES as readonly string[]).includes(harness)) {
    throw new Error(`Manifest ${absPath}: ${at}.harnessType is unknown: "${harness}".`);
  }
  if (!isKnownBotApiType(api)) {
    throw new Error(`Manifest ${absPath}: ${at}.apiType is unknown: "${api}".`);
  }
  const allowed = FIXED_BOT_API_TYPES[harness as SwarmAppBotHarnessType];
  if (allowed && !allowed.includes(api)) {
    throw new Error(`Manifest ${absPath}: ${at} runtime is incompatible: ${harness}/${api}; expected ${allowed.join(' or ')}.`);
  }
  if (harness === 'cline' && !ApiProviderSchema.safeParse(api).success) {
    throw new Error(`Manifest ${absPath}: ${at} runtime is incompatible: cline/${api}; expected a core API provider.`);
  }
}

/** @description Whether a Takeout entry suffix is a canonical relative archive path. */
function isCanonicalTakeoutSuffix(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 512) return false;
  if (value.startsWith('/') || value.includes('\\') || /[\0?#]/.test(value) || value.includes('//')) return false;
  const segments = value.split('/');
  return segments.length >= 2 && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * @description Validate package-owned Google Takeout slice declarations at manifest load.
 * Literal suffixes replace package-provided regular expressions so an installed package cannot
 * inject a catastrophic matcher into the shared archive walk.
 */
function validateTakeoutDeclarations(manifest: SwarmAppManifest, absPath: string): void {
  if (manifest.takeout === undefined) return;
  if (!Array.isArray(manifest.takeout) || manifest.takeout.length === 0) {
    throw new Error(`Manifest ${absPath}: takeout, when present, must be a non-empty array`);
  }
  if (manifest.takeout.length > 16) {
    throw new Error(`Manifest ${absPath}: takeout may declare at most 16 slices`);
  }
  const kinds = new Set<string>();
  const suffixes = new Set<string>();
  for (const [index, value] of manifest.takeout.entries()) {
    const at = `takeout[${index}]`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Manifest ${absPath}: ${at} must be an object`);
    }
    const declaration = value as unknown as Record<string, unknown>;
    const unknown = Object.keys(declaration).filter(
      (key) => !['kind', 'label', 'pathSuffix', 'htmlPathSuffix', 'maxBytes', 'module', 'handler'].includes(key),
    );
    if (unknown.length > 0) {
      throw new Error(`Manifest ${absPath}: ${at} has unknown field(s): ${unknown.join(', ')}`);
    }
    const kind = typeof declaration.kind === 'string' ? declaration.kind.trim() : '';
    if (kind !== declaration.kind || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(kind)) {
      throw new Error(`Manifest ${absPath}: ${at}.kind must be a lowercase slug`);
    }
    if (kinds.has(kind)) throw new Error(`Manifest ${absPath}: duplicate Takeout kind "${kind}"`);
    kinds.add(kind);
    if (
      typeof declaration.label !== 'string'
      || declaration.label !== declaration.label.trim()
      || !declaration.label
      || declaration.label.length > 128
      || /[\0-\x1f\x7f]/.test(declaration.label)
    ) {
      throw new Error(`Manifest ${absPath}: ${at}.label must be 1..128 characters`);
    }
    if (!isCanonicalTakeoutSuffix(declaration.pathSuffix)) {
      throw new Error(`Manifest ${absPath}: ${at}.pathSuffix must be a canonical relative archive suffix`);
    }
    if (
      !declaration.pathSuffix.toLowerCase().startsWith('takeout/')
      || !declaration.pathSuffix.toLowerCase().endsWith('.json')
    ) {
      throw new Error(`Manifest ${absPath}: ${at}.pathSuffix must identify a Takeout/... JSON file`);
    }
    const suffix = declaration.pathSuffix.toLowerCase();
    if (suffixes.has(suffix)) throw new Error(`Manifest ${absPath}: duplicate Takeout pathSuffix "${declaration.pathSuffix}"`);
    suffixes.add(suffix);
    if (
      declaration.htmlPathSuffix !== undefined
      && !isCanonicalTakeoutSuffix(declaration.htmlPathSuffix)
    ) {
      throw new Error(`Manifest ${absPath}: ${at}.htmlPathSuffix must be a canonical relative archive suffix`);
    }
    if (typeof declaration.htmlPathSuffix === 'string') {
      if (
        !declaration.htmlPathSuffix.toLowerCase().startsWith('takeout/')
        || !declaration.htmlPathSuffix.toLowerCase().endsWith('.html')
      ) {
        throw new Error(`Manifest ${absPath}: ${at}.htmlPathSuffix must identify a Takeout/... HTML file`);
      }
      const htmlSuffix = declaration.htmlPathSuffix.toLowerCase();
      if (suffixes.has(htmlSuffix)) {
        throw new Error(`Manifest ${absPath}: duplicate Takeout archive path "${declaration.htmlPathSuffix}"`);
      }
      suffixes.add(htmlSuffix);
    }
    const maxBytes = declaration.maxBytes ?? DEFAULT_TAKEOUT_SLICE_BYTES;
    if (!Number.isInteger(maxBytes) || Number(maxBytes) < 1 || Number(maxBytes) > MAX_TAKEOUT_SLICE_BYTES) {
      throw new Error(`Manifest ${absPath}: ${at}.maxBytes must be an integer from 1 through ${MAX_TAKEOUT_SLICE_BYTES}`);
    }
    if (
      typeof declaration.module !== 'string'
      || !declaration.module.endsWith('.js')
      || path.isAbsolute(declaration.module)
      || declaration.module.includes('\\')
      || declaration.module.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new Error(`Manifest ${absPath}: ${at}.module must be a package-relative compiled .js path`);
    }
    if (typeof declaration.handler !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(declaration.handler)) {
      throw new Error(`Manifest ${absPath}: ${at}.handler must be a JavaScript export name`);
    }
  }
}

/**
 * @description Validate a manifest's `routes[]`, fail-closed, including their auth modes (D2).
 *
 * Nothing checked route declarations before this — a malformed entry was merely skipped at mount,
 * and the auth posture was a single boolean the mounter could not even express. Three classes of
 * error, all of which would otherwise surface as a production 401 storm or an anonymous route:
 *
 *  1. **Shape** — module/factory/mountPath present, mountPath rooted at `/`.
 *  2. **Mode** — `auth` must name a real mode; `auth` and the legacy `requiresAuth` must not
 *     contradict each other (ambiguity in an auth declaration is an author bug, not something to
 *     silently resolve in the author's favour).
 *  3. **Per-mountPath coherence** — every declaration sharing a mountPath must resolve to the SAME
 *     mode. The mounter chains all modules on a mount and runs each entry's guards as it walks, so
 *     mixed modes mean a stricter sibling rejects requests bound for a laxer one purely by
 *     declaration order. (`/api/lora` is the real shape: a service-secret ingest callback and an
 *     OIDC studio on one path. It carves by splitting the mountPaths, or by declaring
 *     `service-or-oidc` for the whole mount — never by mixing.)
 *
 * `public` gets extra scrutiny and a loud WARN: the package dispatcher is installed BEFORE every
 * core `/api` mount, so an anonymous package route on a short mountPath could shadow core paths
 * with no auth and a null-sub RLS context. It must be at least two segments under `/api/`.
 *
 * @param manifest - The parsed manifest.
 * @param absPath - Manifest path, for error messages.
 * @throws When any route declaration is malformed, names an unknown mode, contradicts itself, or
 *         disagrees with a sibling on the same mountPath.
 */
function validateRouteDeclarations(manifest: SwarmAppManifest, absPath: string): void {
  if (manifest.routes === undefined) return;
  if (!Array.isArray(manifest.routes)) {
    throw new Error(`Manifest ${absPath}: routes, when present, must be an array`);
  }

  const modeByMount = new Map<string, { mode: SwarmAppRouteAuthMode; module: string }>();

  for (const [i, decl] of manifest.routes.entries()) {
    const at = `routes[${i}]`;
    for (const field of ['module', 'factory', 'mountPath'] as const) {
      if (typeof decl?.[field] !== 'string' || !decl[field]) {
        throw new Error(`Manifest ${absPath}: ${at} is missing a non-empty ${field}`);
      }
    }
    if (!decl.mountPath.startsWith('/')) {
      throw new Error(`Manifest ${absPath}: ${at}.mountPath must start with '/' (got "${decl.mountPath}")`);
    }
    if (decl.requiresAuth !== undefined && typeof decl.requiresAuth !== 'boolean') {
      throw new Error(`Manifest ${absPath}: ${at}.requiresAuth, when present, must be a boolean`);
    }
    if (decl.requiresAi !== undefined && typeof decl.requiresAi !== 'boolean') {
      throw new Error(`Manifest ${absPath}: ${at}.requiresAi, when present, must be a boolean`);
    }
    if (decl.auth !== undefined && !isRouteAuthMode(decl.auth)) {
      throw new Error(
        `Manifest ${absPath}: ${at}.auth is not a known mode: "${decl.auth}". ` +
          `Known modes: ${ROUTE_AUTH_MODES.join(', ')}.`,
      );
    }
    if (routeAuthContradicts(decl)) {
      throw new Error(
        `Manifest ${absPath}: ${at} declares auth: ${decl.auth} AND requiresAuth: ${decl.requiresAuth}, ` +
          `which contradict. Declare one (prefer auth:).`,
      );
    }

    const mode = resolveRouteAuthMode(decl);

    if (mode === 'public') {
      // Two segments minimum: the package dispatcher runs ahead of core's /api mounts, so a short
      // anonymous mountPath could shadow them entirely.
      if (!/^\/api\/[^/]+/.test(decl.mountPath)) {
        throw new Error(
          `Manifest ${absPath}: ${at} is auth: public but mountPath "${decl.mountPath}" is too broad. ` +
            `An anonymous package route must sit at least two segments under /api/ — the package ` +
            `dispatcher runs BEFORE core's own /api mounts and would otherwise shadow them unauthenticated.`,
        );
      }
      logger.warn(
        { path: absPath, name: manifest.name, mountPath: decl.mountPath, module: decl.module },
        'Package route is ANONYMOUS-CALLABLE (auth: public) — it MUST self-guard (token/HMAC) inside the router',
      );
    }

    const seen = modeByMount.get(decl.mountPath);
    if (seen && seen.mode !== mode) {
      throw new Error(
        `Manifest ${absPath}: mountPath "${decl.mountPath}" declares conflicting auth modes — ` +
          `${seen.module} is ${seen.mode} but ${decl.module} is ${mode}. Every module on one mountPath ` +
          `must agree: the mounter chains them, so a stricter sibling would reject requests meant for a ` +
          `laxer one based purely on declaration order. Split the mountPaths, or pick the mode that ` +
          `admits both callers (usually service-or-oidc).`,
      );
    }
    if (!seen) modeByMount.set(decl.mountPath, { mode, module: decl.module });
  }
}

/** @description Whether a concrete probe path falls on a route's segment boundary. */
function probeBelongsToRoute(probePath: string, mountPath: string): boolean {
  const mount = mountPath.length > 1 ? mountPath.replace(/\/+$/, '') : mountPath;
  return probePath === mount || probePath.startsWith(`${mount}/`);
}

/** @description Whether a deterministic service target is one concrete canonical local path. */
function isCanonicalServiceSchedulePath(value: string): boolean {
  return (
    value.length <= 512 &&
    /^\/api\/[^/]+/.test(value) &&
    !/[?#\\\s]/.test(value) &&
    !value.includes('//') &&
    !/%(?:2e|2f|5c)/i.test(value) &&
    !value.split('/').some((segment) => segment === '.' || segment === '..')
  );
}

/** @description Reject non-JSON values, dangerous keys, and excessive static-body complexity. */
function validateStaticScheduleJson(value: unknown, at: string, depth = 0, budget = { entries: 0 }): void {
  if (depth > MAX_SERVICE_SCHEDULE_JSON_DEPTH) {
    throw new Error(`${at} exceeds the ${MAX_SERVICE_SCHEDULE_JSON_DEPTH}-level JSON depth limit`);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${at} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      budget.entries += 1;
      if (budget.entries > MAX_SERVICE_SCHEDULE_JSON_ENTRIES) throw new Error(`${at} has too many JSON entries`);
      validateStaticScheduleJson(entry, `${at}[${index}]`, depth + 1, budget);
    }
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${at} must contain only plain JSON values`);
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    budget.entries += 1;
    if (budget.entries > MAX_SERVICE_SCHEDULE_JSON_ENTRIES) throw new Error(`${at} has too many JSON entries`);
    if (!key || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new Error(`${at} contains an unsafe JSON key`);
    }
    validateStaticScheduleJson(entry, `${at}.${key}`, depth + 1, budget);
  }
}

/**
 * @description Validate recurring manifest jobs at the package trust boundary. Prompt schedules
 * retain the established contract. A service-route schedule is deliberately narrower: framework
 * scope only, a named compiled export, static JSON only, and an exact path owned by an
 * auth:`service` route.
 */
function validateScheduleDeclarations(manifest: SwarmAppManifest, absPath: string): void {
  if (manifest.schedules === undefined) return;
  if (!Array.isArray(manifest.schedules) || manifest.schedules.length === 0) {
    throw new Error(`Manifest ${absPath}: schedules, when present, must be a non-empty array`);
  }
  const ids = new Set<string>();
  for (const [index, value] of manifest.schedules.entries()) {
    const at = `schedules[${index}]`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Manifest ${absPath}: ${at} must be an object`);
    }
    const schedule = value as unknown as Record<string, unknown>;
    const id = typeof schedule.id === 'string' ? schedule.id.trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new Error(`Manifest ${absPath}: ${at}.id must be a lowercase slug`);
    }
    if (ids.has(id)) throw new Error(`Manifest ${absPath}: duplicate schedule id "${id}"`);
    ids.add(id);

    const cron = typeof schedule.cron === 'string' ? schedule.cron.trim() : '';
    if (cron.split(/\s+/).length !== 5) {
      throw new Error(`Manifest ${absPath}: ${at}.cron must be a standard five-field cron expression`);
    }
    try {
      CronExpressionParser.parse(cron, { currentDate: new Date('2026-01-01T00:00:00.000Z') }).next();
    } catch {
      throw new Error(`Manifest ${absPath}: ${at}.cron is invalid`);
    }
    if (schedule.enabled !== undefined && typeof schedule.enabled !== 'boolean') {
      throw new Error(`Manifest ${absPath}: ${at}.enabled, when present, must be a boolean`);
    }
    if (schedule.description !== undefined && (typeof schedule.description !== 'string' || !schedule.description.trim())) {
      throw new Error(`Manifest ${absPath}: ${at}.description, when present, must be a non-empty string`);
    }

    const target = schedule.target === undefined ? 'prompt' : schedule.target;
    if (target !== 'prompt' && target !== 'service-route') {
      throw new Error(`Manifest ${absPath}: ${at}.target must be prompt or service-route`);
    }
    if (target === 'prompt') {
      const unknown = Object.keys(schedule).filter(
        (key) => !['id', 'cron', 'target', 'prompt', 'targetAgent', 'scope', 'requiresConnection', 'description', 'enabled'].includes(key),
      );
      if (unknown.length > 0) throw new Error(`Manifest ${absPath}: ${at} has unknown field(s): ${unknown.join(', ')}`);
      if (typeof schedule.prompt !== 'string' || !schedule.prompt.trim()) {
        throw new Error(`Manifest ${absPath}: ${at}.prompt must be a non-empty string`);
      }
      if (schedule.targetAgent !== undefined && (typeof schedule.targetAgent !== 'string' || !schedule.targetAgent.trim())) {
        throw new Error(`Manifest ${absPath}: ${at}.targetAgent, when present, must be a non-empty string`);
      }
      if (schedule.scope !== undefined && schedule.scope !== 'framework' && schedule.scope !== 'per-user') {
        throw new Error(`Manifest ${absPath}: ${at}.scope must be framework or per-user`);
      }
      if (schedule.requiresConnection !== undefined && (typeof schedule.requiresConnection !== 'string' || !schedule.requiresConnection.trim())) {
        throw new Error(`Manifest ${absPath}: ${at}.requiresConnection, when present, must be a non-empty string`);
      }
      continue;
    }

    const unknown = Object.keys(schedule).filter(
      (key) => !['id', 'cron', 'target', 'route', 'handler', 'body', 'scope', 'description', 'enabled'].includes(key),
    );
    if (unknown.length > 0) throw new Error(`Manifest ${absPath}: ${at} has unknown field(s): ${unknown.join(', ')}`);
    if (schedule.scope !== undefined && schedule.scope !== 'framework') {
      throw new Error(`Manifest ${absPath}: ${at}.scope must be framework for service-route targets`);
    }
    const routePath = typeof schedule.route === 'string' ? schedule.route : '';
    if (!isCanonicalServiceSchedulePath(routePath)) {
      throw new Error(`Manifest ${absPath}: ${at}.route must be a concrete canonical /api/... path`);
    }
    const owner = (manifest.routes ?? [])
      .filter((route) => probeBelongsToRoute(routePath, route.mountPath))
      .sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
    if (!owner) {
      throw new Error(`Manifest ${absPath}: ${at}.route "${routePath}" is not owned by routes[].mountPath`);
    }
    if (resolveRouteAuthMode(owner) !== 'service') {
      throw new Error(`Manifest ${absPath}: ${at}.route must belong to a route whose auth mode is exactly service`);
    }
    if (typeof schedule.handler !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(schedule.handler)) {
      throw new Error(`Manifest ${absPath}: ${at}.handler must be a named JavaScript export`);
    }
    const body = schedule.body === undefined ? {} : schedule.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error(`Manifest ${absPath}: ${at}.body, when present, must be a static JSON object`);
    }
    validateStaticScheduleJson(body, `Manifest ${absPath}: ${at}.body`);
    if (containsFixtureInterpolation(body)) {
      throw new Error(`Manifest ${absPath}: ${at}.body contains interpolation syntax; scheduled bodies are static and cannot reference secrets`);
    }
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_SERVICE_SCHEDULE_BODY_BYTES) {
      throw new Error(`Manifest ${absPath}: ${at}.body exceeds ${MAX_SERVICE_SCHEDULE_BODY_BYTES} bytes`);
    }
  }
}

/** @description Reject templating syntax anywhere in a parsed JSON fixture. */
function containsFixtureInterpolation(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\$\{[^}]+\}|\{\{[^}]+\}\}|<%[\s\S]*?%>|%[A-Za-z_][A-Za-z0-9_]*%/.test(value);
  }
  if (Array.isArray(value)) return value.some(containsFixtureInterpolation);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, entry]) => containsFixtureInterpolation(key) || containsFixtureInterpolation(entry),
    );
  }
  return false;
}

/** @description Resolve and validate a package-local JSON fixture without following a symlink out. */
function validateSmokeFixture(absPath: string, at: string, fixturePath: string): void {
  if (path.isAbsolute(fixturePath) || !fixturePath.trim() || path.extname(fixturePath).toLowerCase() !== '.json') {
    throw new Error(`Manifest ${absPath}: ${at}.bodyFixture must be a relative package-local .json path`);
  }
  const packageDir = fs.realpathSync(path.dirname(absPath));
  const candidate = path.resolve(packageDir, fixturePath);
  if (!fs.existsSync(candidate)) {
    throw new Error(`Manifest ${absPath}: ${at}.bodyFixture not found: ${fixturePath}`);
  }
  const fixture = fs.realpathSync(candidate);
  const relative = path.relative(packageDir, fixture);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Manifest ${absPath}: ${at}.bodyFixture escapes the package directory`);
  }
  const stat = fs.statSync(fixture);
  if (!stat.isFile() || stat.size > MAX_SMOKE_FIXTURE_BYTES) {
    throw new Error(
      `Manifest ${absPath}: ${at}.bodyFixture must be a regular JSON file no larger than ${MAX_SMOKE_FIXTURE_BYTES} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  } catch (error) {
    throw new Error(`Manifest ${absPath}: ${at}.bodyFixture is not valid JSON: ${(error as Error).message}`);
  }
  if (containsFixtureInterpolation(parsed)) {
    throw new Error(
      `Manifest ${absPath}: ${at}.bodyFixture contains interpolation syntax; smoke fixtures are static and may not reference secrets`,
    );
  }
}

/**
 * @description Validate executable app smoke declarations at the manifest trust boundary. Every
 * probe must be concrete, package-owned, deterministic in shape, and safe to run unattended.
 */
function validateSmokeDeclarations(manifest: SwarmAppManifest, absPath: string): void {
  if (manifest.smoke === undefined) return;
  if (!Array.isArray(manifest.smoke) || manifest.smoke.length === 0) {
    throw new Error(`Manifest ${absPath}: smoke, when present, must be a non-empty array`);
  }
  const routes = manifest.routes ?? [];
  const names = new Set<string>();
  for (const [index, value] of manifest.smoke.entries()) {
    const at = `smoke[${index}]`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Manifest ${absPath}: ${at} must be an object`);
    }
    const smoke = value as unknown as Record<string, unknown>;
    const unknownFields = Object.keys(smoke).filter(
      (key) => !['name', 'method', 'path', 'auth', 'bodyFixture', 'expect', 'requiresAi'].includes(key),
    );
    if (unknownFields.length > 0) {
      throw new Error(`Manifest ${absPath}: ${at} has unknown field(s): ${unknownFields.join(', ')}`);
    }
    const name = typeof smoke.name === 'string' ? smoke.name.trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      throw new Error(`Manifest ${absPath}: ${at}.name must be a lowercase slug`);
    }
    if (names.has(name)) throw new Error(`Manifest ${absPath}: duplicate smoke name "${name}"`);
    names.add(name);

    if (typeof smoke.method !== 'string' || !(SMOKE_METHODS as readonly string[]).includes(smoke.method)) {
      throw new Error(`Manifest ${absPath}: ${at}.method must be one of ${SMOKE_METHODS.join(', ')}`);
    }
    if (typeof smoke.auth !== 'string' || !(SMOKE_AUTH_MODES as readonly string[]).includes(smoke.auth)) {
      throw new Error(`Manifest ${absPath}: ${at}.auth must be one of ${SMOKE_AUTH_MODES.join(', ')}`);
    }
    const probePath = typeof smoke.path === 'string' ? smoke.path : '';
    if (
      !/^\/(?!\/)/.test(probePath) ||
      /[?#\\\s]/.test(probePath) ||
      probePath.includes('//') ||
      probePath.split('/').some((segment) => segment === '.' || segment === '..') ||
      /%(?:2e|2f|5c)/i.test(probePath)
    ) {
      throw new Error(`Manifest ${absPath}: ${at}.path must be a concrete canonical root-relative path`);
    }
    const owningRoutes = routes
      .filter((route) => probeBelongsToRoute(probePath, route.mountPath))
      .sort((a, b) => b.mountPath.length - a.mountPath.length);
    if (owningRoutes.length === 0) {
      throw new Error(`Manifest ${absPath}: ${at}.path "${probePath}" is not owned by a declared routes[].mountPath`);
    }
    if (smoke.requiresAi !== undefined && typeof smoke.requiresAi !== 'boolean') {
      throw new Error(`Manifest ${absPath}: ${at}.requiresAi, when present, must be a boolean`);
    }
    if (smoke.requiresAi === true && owningRoutes[0].requiresAi !== true) {
      throw new Error(
        `Manifest ${absPath}: ${at} requires AI but its owning route ${owningRoutes[0].mountPath} does not declare requiresAi: true`,
      );
    }

    if (smoke.bodyFixture !== undefined) {
      if (typeof smoke.bodyFixture !== 'string') {
        throw new Error(`Manifest ${absPath}: ${at}.bodyFixture, when present, must be a string`);
      }
      if (smoke.method === 'GET' || smoke.method === 'HEAD') {
        throw new Error(`Manifest ${absPath}: ${at}.bodyFixture is not allowed for ${smoke.method}`);
      }
      validateSmokeFixture(absPath, at, smoke.bodyFixture);
    }

    const expect = smoke.expect;
    if (!expect || typeof expect !== 'object' || Array.isArray(expect)) {
      throw new Error(`Manifest ${absPath}: ${at}.expect must be an object`);
    }
    const expectation = expect as Record<string, unknown>;
    const unknownExpect = Object.keys(expectation).filter(
      (key) => !['status', 'jsonPointer', 'rejectValues'].includes(key),
    );
    if (unknownExpect.length > 0) {
      throw new Error(`Manifest ${absPath}: ${at}.expect has unknown field(s): ${unknownExpect.join(', ')}`);
    }
    if (!Number.isInteger(expectation.status) || Number(expectation.status) < 100 || Number(expectation.status) > 599) {
      throw new Error(`Manifest ${absPath}: ${at}.expect.status must be an HTTP status integer`);
    }
    if (
      expectation.jsonPointer !== undefined &&
      (typeof expectation.jsonPointer !== 'string' ||
        (expectation.jsonPointer !== '' && !expectation.jsonPointer.startsWith('/')) ||
        /~(?![01])/.test(expectation.jsonPointer))
    ) {
      throw new Error(`Manifest ${absPath}: ${at}.expect.jsonPointer must be a valid RFC 6901 pointer`);
    }
    if (expectation.rejectValues !== undefined) {
      if (
        !Array.isArray(expectation.rejectValues) ||
        expectation.rejectValues.length === 0 ||
        expectation.rejectValues.some(
          (item) => item !== null && !['string', 'number', 'boolean'].includes(typeof item),
        )
      ) {
        throw new Error(`Manifest ${absPath}: ${at}.expect.rejectValues must be a non-empty scalar array`);
      }
      if (expectation.jsonPointer === undefined) {
        throw new Error(`Manifest ${absPath}: ${at}.expect.rejectValues requires expect.jsonPointer`);
      }
    }
  }
}

/**
 * @description Reads a manifest YAML file, parses it, and returns a
 * typed SwarmAppManifest. Throws with a clear message on malformed input
 * so the caller (SwarmAppService.loadApp) can surface the error without
 * guessing.
 * @param manifestPath - absolute or cwd-relative path to the YAML file
 * @returns the parsed manifest
 */
export function readManifest(manifestPath: string): SwarmAppManifest {
  const absPath = path.isAbsolute(manifestPath)
    ? manifestPath
    : path.resolve(process.cwd(), manifestPath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Manifest file not found: ${absPath}`);
  }

  const raw = fs.readFileSync(absPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err: any) {
    throw new Error(`Manifest YAML parse failed for ${absPath}: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Manifest is empty or not an object: ${absPath}`);
  }

  const manifest = parsed as SwarmAppManifest;
  const missing = REQUIRED_FIELDS.filter(f => !manifest[f]);
  if (missing.length > 0) {
    throw new Error(`Manifest ${absPath} missing required fields: ${missing.join(', ')}`);
  }
  // bots is optional, but if present it must be a non-empty array (a typo'd/empty
  // bots: key is a mistake worth failing on; a deliberately bot-less app omits it).
  if (manifest.bots !== undefined && (!Array.isArray(manifest.bots) || manifest.bots.length === 0)) {
    throw new Error(`Manifest ${absPath}: bots, when present, must be a non-empty array`);
  }

  // ADR-090 D8: `uses:` names KERNEL SKILLS, and validation is fail-closed. An unknown id here
  // would otherwise surface as a mount-time crash inside the installed app (the module the
  // package imports simply isn't in the image) — catch the typo at load, where it's cheap.
  if (manifest.uses !== undefined) {
    if (!Array.isArray(manifest.uses)) {
      throw new Error(`Manifest ${absPath}: uses, when present, must be an array of kernel-skill ids`);
    }
    const unknown = manifest.uses.filter((s) => typeof s !== 'string' || !isKernelSkillId(s));
    if (unknown.length > 0) {
      throw new Error(
        `Manifest ${absPath}: uses names unknown kernel skill(s): ${unknown.join(', ')}. ` +
          `Known skills: ${[...KERNEL_SKILL_IDS].join(', ')}. ` +
          `A skill is a kernel capability an app CALLS — an app dependency goes under dependencies.apps.`,
      );
    }
  }

  // ADR-090 addendum: `skillProfiles:` names PROFILEABLE CAPABILITIES (not kernel modules), and
  // validation is fail-closed on both the key AND the body. An unknown capability key would sit in
  // the manifest looking meaningful while the dispatch resolver silently never matches it; a profile
  // with no pattern/instructions is a no-op stub (the no-mock rule). YAML parses an empty
  // `skillProfiles:` to null and a map to an object, so the object-shape guard runs BEFORE entries().
  if (manifest.skillProfiles !== undefined) {
    if (
      manifest.skillProfiles === null ||
      typeof manifest.skillProfiles !== 'object' ||
      Array.isArray(manifest.skillProfiles)
    ) {
      throw new Error(
        `Manifest ${absPath}: skillProfiles, when present, must be a map of capability-id -> profile`,
      );
    }
    for (const [cap, profile] of Object.entries(manifest.skillProfiles)) {
      if (!isSkillCapabilityId(cap)) {
        throw new Error(
          `Manifest ${absPath}: skillProfiles names unknown capability "${cap}". ` +
            `Known capabilities: ${[...SKILL_CAPABILITY_IDS].join(', ')}. ` +
            `A profile teaches a bot capability an app's domain pattern — it is NOT a kernel module (that is uses:).`,
        );
      }
      const p = profile as { pattern?: unknown; instructions?: unknown } | null;
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        throw new Error(`Manifest ${absPath}: skillProfiles.${cap} must be an object with pattern + instructions`);
      }
      if (typeof p.pattern !== 'string' || !p.pattern.trim()) {
        throw new Error(`Manifest ${absPath}: skillProfiles.${cap}.pattern must be a non-empty domain label`);
      }
      if (typeof p.instructions !== 'string' || !p.instructions.trim()) {
        throw new Error(
          `Manifest ${absPath}: skillProfiles.${cap}.instructions must be non-empty — a profile with a ` +
            `label but no guidance is a no-op stub (the accountable bot needs the pattern to shape its output).`,
        );
      }
      // Fail closed on the OPTIONAL fields the dispatch composer consumes too — a mistyped
      // `sections` (a string, not a list) or a numeric `outputContract` would pass this block and
      // then throw an unhelpful TypeError inside composeSkillProfilePrompt at dispatch. Catch it here.
      const opt = profile as { sections?: unknown; outputContract?: unknown };
      if (
        opt.sections !== undefined &&
        (!Array.isArray(opt.sections) || opt.sections.some((s) => typeof s !== 'string' || !s.trim()))
      ) {
        throw new Error(
          `Manifest ${absPath}: skillProfiles.${cap}.sections, when present, must be an array of non-empty strings`,
        );
      }
      if (
        opt.outputContract !== undefined &&
        (typeof opt.outputContract !== 'string' || !opt.outputContract.trim())
      ) {
        throw new Error(
          `Manifest ${absPath}: skillProfiles.${cap}.outputContract, when present, must be a non-empty string`,
        );
      }
    }
  }

  // ADR-118: access is an authorization contract, so its entire shape and closed vocabulary
  // fail at load. Omission is deliberate rollout compatibility and keeps current behavior.
  validateAppAccess(manifest, absPath);

  // ADR-085 D4: guestTier is a REQUEST, not a grant — it does nothing until an operator approves it.
  // Still fail closed on the VALUE: an unrecognised tier must not sit in a manifest looking approved,
  // and a typo should surface at load, not at the operator's review screen.
  if (manifest.guestTier !== undefined && !isGuestTier(manifest.guestTier)) {
    throw new Error(
      `Manifest ${absPath}: guestTier is not a known tier: "${manifest.guestTier}". ` +
        `Known tiers: ${GUEST_TIERS.join(', ')}. Note it is a REQUEST — an operator must approve it ` +
        `before it takes effect (guests are unauthenticated; an app may not widen its own exposure).`,
    );
  }

  // ADR-097: suite is the app's ONE primary catalog shelf. The VALUE is fail-closed (a typo'd
  // suite must not silently invent a new shelf); PRESENCE is warn-only so pre-097 installed
  // packages (little-monsters, portrait-studio, …) keep booting — the warn is their upgrade
  // prompt. Deliberately NOT derived from tool category: values — tools are ingredients, the
  // suite is the job (an ai-finance app legitimately bundles media + communication tools).
  if (manifest.suite !== undefined && !isSwarmAppSuite(manifest.suite)) {
    throw new Error(
      `Manifest ${absPath}: suite is not a known catalog suite: "${manifest.suite}". ` +
        `Known suites: ${SWARM_APP_SUITES.join(', ')}. An app declares exactly ONE primary ` +
        `suite (ADR-097); adding a new suite is a deliberate schema change in ` +
        `src/features/swarm-apps/types.ts, not a manifest-side invention.`,
    );
  }
  if (manifest.suite === undefined) {
    logger.warn(
      { path: absPath, name: manifest.name },
      'Manifest declares no suite (ADR-097) — it will list under "More" in the catalog until one is added',
    );
  }

  // ADR-085 D3: bots[].accessRoles (ADR-087 parity for packaged bots). Fail closed — an unknown
  // role or an empty list must not silently leave a bot open to every caller, Jarvis included.
  for (const [i, bot] of (manifest.bots ?? []).entries()) {
    validateBotRuntime(bot, i, absPath);
    if (bot.accessRoles === undefined) continue; // omitted = open to every caller (ADR-087)
    const at = `bots[${i}] (${bot.name ?? '?'})`;
    // `accessRoles:` with no values parses to null in YAML — the likeliest author typo, and the
    // one that would otherwise read as "no restrictions" rather than the intended restriction.
    if (!Array.isArray(bot.accessRoles) || bot.accessRoles.length === 0) {
      throw new Error(
        `Manifest ${absPath}: ${at}.accessRoles, when present, must be a NON-EMPTY array of caller roles ` +
          `(${SWARM_ACCESS_ROLES.join(', ')}). Omit the key entirely to leave the bot open to every caller.`,
      );
    }
    const unknown = bot.accessRoles.filter((r) => !isSwarmAccessRole(r));
    if (unknown.length > 0) {
      throw new Error(
        `Manifest ${absPath}: ${at}.accessRoles names unknown caller role(s): ${unknown.join(', ')}. ` +
          `Known roles: ${SWARM_ACCESS_ROLES.join(', ')}.`,
      );
    }
  }

  // Surface-bridge allow-list: `surface.ops` names the ONLY oshal-surface-bridge ops the cockpit
  // relay carries for this app (fail-closed — no declaration = nothing relayed). Validate the
  // VALUE fail-closed against the shared closed vocabulary: a typo'd op would otherwise sit in
  // the manifest looking meaningful while the relay silently drops every event it sends.
  if (manifest.surface !== undefined) {
    if (
      manifest.surface === null ||
      typeof manifest.surface !== 'object' ||
      Array.isArray(manifest.surface) ||
      !Array.isArray(manifest.surface.ops)
    ) {
      throw new Error(
        `Manifest ${absPath}: surface, when present, must be an object with an ops array ` +
          `(surface.ops: [${[...SURFACE_BRIDGE_OPS].join(', ')}]). Omit the block entirely for an app ` +
          `that doesn't speak the bridge — absence and [] both relay nothing (fail-closed).`,
      );
    }
    const unknownOps = manifest.surface.ops.filter((op) => !isSurfaceBridgeOp(op));
    if (unknownOps.length > 0) {
      throw new Error(
        `Manifest ${absPath}: surface.ops names unknown surface-bridge op(s): ${unknownOps.join(', ')}. ` +
          `Known ops: ${[...SURFACE_BRIDGE_OPS].join(', ')}. App-specific vocabulary rides the 'custom' ` +
          `(outbound) and 'event' (inbound) ops — the closed set never grows per app.`,
      );
    }
  }

  // ADR-085 D2: routes[] auth. Fail closed — auth is opt-in per route in this codebase, so a
  // package route must never become anonymous-callable through a typo or an omission.
  validateRouteDeclarations(manifest, absPath);
  validateScheduleDeclarations(manifest, absPath);
  validateTakeoutDeclarations(manifest, absPath);
  validateSmokeDeclarations(manifest, absPath);

  // ADR-085 D9: the assistant bubble is rendered BY THE FRAMEWORK, inside the cockpit's
  // authenticated origin. Its iframeUrl must therefore be same-origin and root-relative — an
  // absolute URL, a protocol-relative `//host`, or a `javascript:` URL would turn a declarative
  // widget back into the arbitrary-code channel this field exists to avoid. Fail closed at load.
  const assistant = manifest.ui?.assistant;
  if (assistant !== undefined) {
    const bad = !assistant.label || !assistant.icon || !assistant.iframeUrl;
    if (bad) {
      throw new Error(`Manifest ${absPath}: ui.assistant requires label, icon and iframeUrl`);
    }
    if (!/^\/(?!\/)/.test(assistant.iframeUrl)) {
      throw new Error(
        `Manifest ${absPath}: ui.assistant.iframeUrl must be a same-origin, root-relative path ` +
          `(got "${assistant.iframeUrl}"). Absolute, protocol-relative and javascript: URLs are refused — ` +
          `the assistant renders inside the cockpit's authenticated origin.`,
      );
    }
  }

  // ADR-085 D12: `toolsDir` is DECLARED BUT DEAD — nothing in core consumes it, so a package's
  // bundled tool JS is not callable. Warn rather than fail (little-monsters declares it today);
  // the field is removed in the next store release (operator decision, 2026-07-13).
  if (manifest.toolsDir) {
    logger.warn(
      { path: absPath, name: manifest.name, toolsDir: manifest.toolsDir },
      'Manifest declares toolsDir, but nothing in core consumes it — bundled tool JS is NOT callable. ' +
        'The field is inert and will be removed in the next store release; drop it from the manifest.',
    );
  }

  logger.info(
    { path: absPath, name: manifest.name, botCount: manifest.bots?.length ?? 0, uses: manifest.uses ?? [] },
    'Manifest loaded',
  );
  return manifest;
}

/**
 * @description Lists manifest file paths in the conventional directory
 * (swarm-apps/) so the boot path can auto-load every installed app.
 * @returns absolute file paths of every *.yaml file in swarm-apps/
 */
export function listManifestFiles(): string[] {
  // Built-in apps live in swarm-apps/ (read-only); codex-packer-deployed swarms
  // live in the writable deployed-apps/ under the workspace root. Load both so a
  // deployed swarm survives a restart.
  const dirs = [
    path.resolve(process.cwd(), 'swarm-apps'),
    path.join(process.env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared', 'deployed-apps'),
    // ADR-085 D5: extra manifest dirs, comma-separated. UNSET in production — this exists so the
    // test server can load a PERMANENT fixture app (tests/fixtures/swarm-apps/) without shipping it
    // as a real product app. Shared specs used to fixture a real one (little-monsters, then
    // gov-contracting after LM carved), so every carve broke them and they had to be re-pointed —
    // a treadmill that ends when the whole point of the migration is that any app can carve.
    ...(process.env.SWARM_APPS_EXTRA_DIRS || '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => path.resolve(process.cwd(), d)),
  ];
  const out: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (f.endsWith('.yaml') || f.endsWith('.yml')) {
        out.push(full);
        continue;
      }
      // ADR-085 package layout: an installed app is a FOLDER with its manifest at
      // <dir>/<name>/oshal-app.yaml (one level deep only — packages don't nest).
      try {
        const pkgManifest = path.join(full, 'oshal-app.yaml');
        if (fs.statSync(full).isDirectory() && fs.existsSync(pkgManifest)) out.push(pkgManifest);
      } catch { /* unreadable entry — skip */ }
    }
  }
  return out;
}

/**
 * @description Serialises a manifest back to YAML — used by the export
 * endpoint when operators transfer an app between OSHAL instances.
 * @param manifest - the in-memory manifest
 * @returns the YAML string (including a leading comment header)
 */
export function serializeManifest(manifest: SwarmAppManifest): string {
  const header = [
    '# Swarm Application Manifest — exported',
    `# App: ${manifest.name}`,
    `# Generated: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  return header + yaml.dump(manifest, { lineWidth: 120, noRefs: true });
}
