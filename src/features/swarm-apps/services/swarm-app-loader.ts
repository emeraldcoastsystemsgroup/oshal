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
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
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
