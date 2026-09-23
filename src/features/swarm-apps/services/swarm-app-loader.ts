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
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 Stage 1: validate the artifacts: ("Send to…") block fail-closed — a malformed declaration (bad MIME glob, off-mount endpoint, unknown mode) fails the app load instead of half-registering a dead menu entry.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: fail manifest load on malformed access blocks, unknown/duplicate tiers, missing deny, unsupported defaults, and invalid capability mappings.
 * 10 | maintainer@emeraldcoastsystemsgroup.com  | INSTALLER-GAPS CORE-05: validate package-owned smoke probes, confined JSON fixtures, route ownership, and explicit AI-route metadata.
 * 11 | maintainer@emeraldcoastsystemsgroup.com  | Validate manifest-contributed Takeout slices fail-closed: literal canonical suffixes only, confined compiled modules, bounded uncompressed bytes, unique stable ids/paths, and named handler exports.
 * 12 | maintainer@emeraldcoastsystemsgroup.com  | Validate both manifest schedule modes fail-closed. Deterministic service-route jobs must be framework-scoped static POSTs beneath an exactly service-authenticated package route; malformed cron, mixed prompt/route fields, dynamic interpolation, and oversized bodies are rejected at load.
 * 13 | maintainer@emeraldcoastsystemsgroup.com  | ADR-093 Tier 2: validate bots[].container/port fail-closed (service-name slug, sane port, port requires container, 'oshal-api' rejected) — a malformed node declaration must fail the load, not silently register the bot inline on a runtime the operator opted out of.
 * 14 | maintainer@emeraldcoastsystemsgroup.com  | ADR-141: readManifest validates `kind: group` (no code keys, members required, toolbar borrows only from members, setup steps name a member + a toolbar surface) and the per-user `readiness:` block (own mount, canonical path, session-admitting route, RFC 6901 pointers) — both fail closed at load, from swarm-app-group.ts.
 * 15 | maintainer@emeraldcoastsystemsgroup.com | Validate explicit user smoke prerequisites against read-only PAT probes and the closest session-authenticated route.
 * 16 | maintainer@emeraldcoastsystemsgroup.com | Validate package-owned tool declarations through the shared tool contract before activation.
 * 17 | maintainer@emeraldcoastsystemsgroup.com | Validate dependencies (required/optional tiers or the legacy flat form) through the shared CLI/runtime contract, fail-closed at load.
 * 18 | maintainer@emeraldcoastsystemsgroup.com | ADR-157 S1: move the whole schedule contract (prompt + service-route rules, the static-JSON walker, probeBelongsToRoute and containsFixtureInterpolation) into manifest-schedule-validation.ts — this file was 836 code lines, past its 800 budget — and hand that validator the imported authorization catalog so a service schedule's `requires` is checked against the permissions the app actually defines.
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Refuse `pipeline: staged` at load (CKR-10 / D2). Its executor was retired for the graph engine, so such a manifest fell through to manifest-worker and ran only workerBot with every authored approval gate dropped and nothing logged - a silently wrong run. Refused with the two pipelines that do work named in the message. Publish is unaffected: the studio compiles its own staged authoring into a graph and never emits this value.
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | readManifest refuses two more silently-degrading workflow shapes (CKR-11 / D4). `pipeline: graph` with no processDefinition has no graph to execute, so every ticket of that type escalates on arrival; and a workflow with no workerBot and no executable graph falls through to the 7-phase 'swarm' decompose pipeline, which is both wrong and expensive. Refused at load rather than at dispatch, because by dispatch a ticket exists and a person is waiting on it. Audited before landing: every workflow in the ten core manifests and all 61 store packages declares a workerBot, and print-ingest was the only manifest in either trunk with the graph-without-definition shape - fixed in the store first. Extracted to a helper and corrected after review: the definition check reads processDefinition.nodeGraph rather than the object's truthiness, because the engine walks nodeGraph and an empty object would have loaded here and escalated at dispatch anyway; and a near-miss pipeline spelling ('graph ', 'Graph') is refused, because this function trims while the router compares exactly, so accepting one would bless a value the router sends to manifest-worker - the very degradation being fixed.
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | CKR-17 step 2: the inline workspace-root chain here resolves through resolveSharedWorkspaceRoot() like every other site. It read ONE of the six, and it is where an installed store package is discovered.
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | P8 concierge coverage: every manifest read resolves the fail-closed OSHAL_CONCIERGE_COVERAGE_MODE. A package with a real cockpit surface and no canonical concierge emits one stable structured warning in the migration default (`warn`) or fails the load in `enforce`; there is no package-name allowlist.
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | Complete the P8 rollout after the store backfill: surfaced packages without a canonical concierge now fail under the unset `enforce` default; `warn` remains an explicit temporary observation/rollback posture.
 */

import { validateBriefingDeclarations } from '@/shared/briefings';
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
import { validateArtifactActionsDeclaration } from '@/shared/artifact-exchange';
import { loadApplicationAuthorization } from '@/shared/application-authorization';
import { validatePackageTools } from '@/shared/package-tools';
import { loadPackageTestCatalog } from '@/shared/package-testing';
import { readAppDependencies } from '@/shared/app-dependencies';
import { validateGroupManifest, validateReadinessDeclarations, validateGuestSeedDeclaration, validateSummaryDeclaration } from './swarm-app-group';
import { validateAppIntegrations } from './app-integrations';
import { containsFixtureInterpolation, probeBelongsToRoute, validateScheduleDeclarations } from './manifest-schedule-validation';
import {
  CONCIERGE_COVERAGE_WARNING_EVENT,
  CONCIERGE_COVERAGE_WARNING_MESSAGE,
  conciergeCoverageProblem,
  resolveConciergeCoverageMode,
} from './swarm-app-concierge';
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
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';

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

/**
 * @description Fail closed on malformed dedicated-node declarations (ADR-093 Tier 2). A bad
 * `container:` must fail the load, not silently register the bot inline — the operator applied a
 * node service expecting dispatch to reach it, and an inline fallback would run the bot on a
 * runtime (and brain ladder) they explicitly opted out of.
 */
function validateBotNodeDeclaration(bot: SwarmAppBotDeclaration, index: number, absPath: string): void {
  const at = `bots[${index}] (${bot && bot.name || '?'})`;
  const { container, port } = bot ?? {};
  if (container !== undefined) {
    if (typeof container !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(container)) {
      throw new Error(`Manifest ${absPath}: ${at}.container must be a Docker service-name slug (lowercase alphanumeric + hyphen).`);
    }
    if (container === 'oshal-api') {
      throw new Error(`Manifest ${absPath}: ${at}.container must name a dedicated bot-node service — 'oshal-api' is the inline default; omit the key instead.`);
    }
  }
  if (port !== undefined) {
    if (container === undefined) {
      throw new Error(`Manifest ${absPath}: ${at}.port is only meaningful together with container:.`);
    }
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Manifest ${absPath}: ${at}.port must be an integer TCP port (1-65535).`);
    }
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

/** Validate the explicit user prerequisite against the closest owning route. */
function validateUserSmokeRequirement(smoke: Record<string, unknown>, routeAuth: unknown, at: string): void {
  if (smoke.requiresUser !== undefined && typeof smoke.requiresUser !== 'boolean') {
    throw new Error(`${at}.requiresUser must be a boolean`);
  }
  if (smoke.requiresUser !== true) return;
  if (!['GET', 'HEAD'].includes(String(smoke.method)) || smoke.auth !== 'pat') {
    throw new Error(`${at}.requiresUser requires GET or HEAD with auth: pat`);
  }
  if (!['oidc', 'service-or-oidc'].includes(String(routeAuth))) {
    throw new Error(`${at}.requiresUser requires an owning oidc or service-or-oidc route`);
  }
}

/** Validate executable smoke declarations before activation. */
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
      (key) => !['name', 'method', 'path', 'auth', 'bodyFixture', 'expect', 'requiresAi', 'requiresUser'].includes(key),
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
    validateUserSmokeRequirement(smoke, owningRoutes[0].auth, `Manifest ${absPath}: ${at}`);
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
/** Pipelines the dispatcher has an executor for. A value outside this set is a label an app
 *  contributed, which falls through to 'swarm' by design (see dispatch-routing). */
const KNOWN_PIPELINES = ['graph', 'manifest-worker', 'swarm', 'incident-rca'] as const;

/** Pipelines that legitimately run with no workerBot. */
const EXPLICIT_NO_WORKER_BOT = new Set<string>(['swarm', 'incident-rca']);

/**
 * @description Refuses a workflow that would run as something other than what its author declared.
 * @param manifest - The parsed manifest.
 * @param absPath - Absolute manifest path, for the message.
 * @returns Nothing; throws on a shape with no executor.
 *
 * Refused at load rather than at dispatch, because by dispatch a ticket exists and a person is
 * waiting on it.
 */
function assertWorkflowHasAnExecutor(
  manifest: { name?: unknown; ticketType?: unknown; workflow?: unknown },
  absPath: string,
): void {
  const workflow = manifest.workflow as {
    pipeline?: unknown; workerBot?: unknown; processDefinition?: unknown;
  } | undefined;
  if (!workflow) return;

  const raw = String(workflow.pipeline ?? '');
  const pipeline = raw.trim();
  const where = `Manifest ${absPath}: app '${String(manifest.name ?? '')}'`;
  const ticketType = String(manifest.ticketType ?? '');

  // A near-miss spelling is refused rather than accepted. The router compares the pipeline
  // EXACTLY (dispatch-routing) while this function trims, so accepting 'graph ' here would bless
  // a value the router then sends to manifest-worker - the exact silent degradation this whole
  // check exists to stop. A genuinely unknown label is still legal: apps contribute their own,
  // and those fall through to 'swarm' by design. Only a value that looks like it MEANT one of
  // ours is refused.
  const canonical = KNOWN_PIPELINES.find((known) => known === pipeline.toLowerCase());
  if (canonical && raw !== canonical) {
    throw new Error(
      `${where} declares workflow.pipeline ${JSON.stringify(raw)}, which the dispatcher compares ` +
      `exactly and would not match. Write '${canonical}'.`,
    );
  }

  // 'graph' names the ProcessDefinition engine, and the engine walks `processDefinition.nodeGraph`
  // - dispatchGraphTicket escalates on `!definition || !definition.nodeGraph`. Checking the
  // definition's truthiness alone would let `processDefinition: {}` load and escalate at dispatch
  // anyway, which is precisely what this refusal is supposed to prevent.
  const hasGraph = Boolean((workflow.processDefinition as { nodeGraph?: unknown } | undefined)?.nodeGraph);
  if (pipeline === 'graph' && !hasGraph) {
    throw new Error(
      `${where} declares workflow.pipeline 'graph' but no workflow.processDefinition.nodeGraph. ` +
      `There is no graph to execute, so every ticket of type '${ticketType}' escalates on arrival. ` +
      `Add a processDefinition carrying a nodeGraph (the workflow studio's Publish emits one), or ` +
      `use 'manifest-worker' for a single-bot run.`,
    );
  }

  // No workerBot and nothing else to run means the ticket falls through to the 7-phase 'swarm'
  // decompose pipeline - wrong, and expensive. An author who WANTS that says so explicitly.
  const hasWorkerBot = Boolean(String(workflow.workerBot ?? '').trim());
  if (!hasWorkerBot && !(pipeline === 'graph' && hasGraph) && !EXPLICIT_NO_WORKER_BOT.has(pipeline)) {
    throw new Error(
      `${where} declares a workflow with no workflow.workerBot and no executable graph, so tickets ` +
      `of type '${ticketType}' would run the 7-phase 'swarm' decompose pipeline instead. Name a ` +
      `workerBot, supply a processDefinition, or declare pipeline 'swarm' if that is what you want.`,
    );
  }
}

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
  // This is a deployment-wide enforcement posture, not a package hint. Resolve it for EVERY
  // read (including headless manifests) so a typo cannot quietly turn intended enforcement off.
  const conciergeCoverageMode = resolveConciergeCoverageMode();
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
          `A skill is a kernel capability an app CALLS — an app dependency goes under dependencies.required/optional.`,
      );
    }
  }
  // `pipeline: staged` has no executor. It was retired in favour of the graph engine, and a
  // manifest that declares it falls through chooseDispatchPath to manifest-worker: only workerBot
  // runs, every approval gate the author wrote is dropped, and nothing is logged. That is a
  // silently wrong run, so it is refused at load rather than accepted and quietly degraded.
  // Publish is unaffected - the studio compiles its own staged authoring INTO a graph.
  if (manifest.workflow && String((manifest.workflow as { pipeline?: unknown }).pipeline ?? '').trim() === 'staged') {
    throw new Error(
      `Manifest ${absPath}: pipeline 'staged' has no executor and would run only workerBot, ` +
      `dropping every approval gate. Use pipeline 'graph' with a processDefinition, which the ` +
      `workflow studio's Publish emits, or 'manifest-worker' for a single-bot workflow.`,
    );
  }

  assertWorkflowHasAnExecutor(manifest, absPath);

  try { readAppDependencies(manifest); } catch (err) { throw new Error(`Manifest ${absPath}: ${(err as Error).message}`); }

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
  const authorizationCatalog = loadApplicationAuthorization(path.dirname(absPath), manifest);
  validatePackageTools(manifest);
  loadPackageTestCatalog(path.dirname(absPath), manifest);

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

  // ADR-139: the artifacts: block ("Send to…" declarations) is optional, but a malformed one
  // fails the LOAD — a bad MIME glob or an off-mount endpoint must never half-register into the
  // shared menu registry where the defect surfaces as a dead menu entry far from its cause.
  const artifactsError = validateArtifactActionsDeclaration(manifest.artifacts);
  if (artifactsError) {
    throw new Error(`Manifest ${absPath}: ${artifactsError} (ADR-139 — fix the artifacts: block; the app will not load until it validates)`);
  }

  // ADR-085 D3: bots[].accessRoles (ADR-087 parity for packaged bots). Fail closed — an unknown
  // role or an empty list must not silently leave a bot open to every caller, Jarvis included.
  for (const [i, bot] of (manifest.bots ?? []).entries()) {
    validateBotRuntime(bot, i, absPath);
    validateBotNodeDeclaration(bot, i, absPath);
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
  validateScheduleDeclarations(manifest, absPath, authorizationCatalog);
  validateTakeoutDeclarations(manifest, absPath);
  validateSmokeDeclarations(manifest, absPath);
  if (manifest.briefings !== undefined) {
    validateBriefingDeclarations(manifest.briefings, (manifest.bots ?? []).map(bot => bot.agentId), Boolean(manifest.authorization));
    if (!manifest.uses?.includes('jarvis-briefings')) throw new Error('Manifest briefings require uses: [jarvis-briefings]');
  }
  // ADR-141: a `kind: group` manifest carries no code and borrows member surfaces by reference;
  // `readiness:` is the per-user sibling of `smoke:`. Both fail closed here, at load.
  validateGroupManifest(manifest, absPath);
  validateReadinessDeclarations(manifest, absPath);
  validateSummaryDeclaration(manifest, absPath);
  validateAppIntegrations(manifest, absPath);
  // Guest-seed contract: the manifest's `guestSeed:` hook, fail-closed like smoke/readiness.
  validateGuestSeedDeclaration(manifest, absPath);

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

  // P8: anything the cockpit can open needs an accountable conversational entry point. The
  // The completed rollout is enforce-by-default with no allowlist; `warn` is an explicit
  // temporary observation posture. `hasCockpitSurface` is shared with app listings.
  const conciergeCoverageError = conciergeCoverageProblem(manifest, absPath);
  if (conciergeCoverageError) {
    if (conciergeCoverageMode === 'enforce') throw new Error(conciergeCoverageError);
    logger.warn(
      {
        event: CONCIERGE_COVERAGE_WARNING_EVENT,
        app: manifest.name,
        path: absPath,
        mode: conciergeCoverageMode,
      },
      CONCIERGE_COVERAGE_WARNING_MESSAGE,
    );
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
    path.join(resolveSharedWorkspaceRoot(), 'deployed-apps'),
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
