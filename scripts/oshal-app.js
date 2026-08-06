#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 developer helper: the `oshal-app` CLI — `init` scaffolds a new app package, `validate` lints a package against the app-package contract (self-contained, well-formed manifest, bundled files present, agentId uniqueness, deps well-formed).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 gap-closure: `build <dir> --framework <checkout>` (compile src-routes/*.ts -> routes/*.js against a checkout, @/ preserved, self-containment verified, transient copies cleaned) + `install` now resolves dependencies.apps npm-style (installed -> core swarm-apps -> store recursive, fail-closed) and records the resolution in .oshal-install.json.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Add `install <name>` — sparse git-subdir pull of a package from a store repo (default oshal-applications) into deployed-apps/, validated before landing, with a pinned-sha provenance stamp. Proven end-to-end: install hello-oshal from the external repo → route serves.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | `install` honors OSHAL_STORE_TOKEN (fallback GITHUB_TOKEN) for private store repos and scrubs authentication material from errors. The original URL transport is superseded by sequence 9.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 D8: validate `uses:` (kernel skills) shape, and warn when an author lists the `presentations` APP as a dependency when they mean the always-present deck-generation SKILL. Skill IDs are deliberately NOT re-listed here — the authoritative fail-closed check is server-side (readManifest) + CI (check-kernel-skills.ts); a second list in this CLI would drift.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-097 store follow-up: `init` scaffold stamps `suite:` (the app's ONE primary catalog shelf) so generated packages never land unshelved; `validate` warns on a missing suite and errors on a non-string one. The suite ENUM is deliberately NOT re-listed here — the authoritative fail-closed value check is server-side (swarm-app-loader against SWARM_APP_SUITES), same no-second-source reasoning as `uses:`.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D11 done-when 6: `uninstall`'s impact scan now mirrors the SERVER's tool semantics (tool-ownership.ts) — tools PROVIDED = the manifest's tools[].name only (never ui.static[].toolName, those are ribbon surface ids); other installed packages whose dependencies.tools name one are TOOL DEPENDENTS and BLOCK the uninstall exactly like app-level dependents (--force overrides). A dependent blocks, it never RETAINS the tool — under --force the tool goes with its owner, same as the server.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Default the store to the PUBLIC repo, matching scripts/oshal-install.sh. The CLI defaulted to the private trunk, so `oshal-app.js install <name>` 404'd for anyone outside the org while the shell installer — same product, same install — succeeded from the public snapshot. The trunk is now reached by naming it (--repo / OSHAL_STORE_REPO) plus OSHAL_STORE_TOKEN.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: private-store tokens now reach Git through --config-env and a one-process Authorization header environment value; clone URLs and process argv remain credential-free.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: validate the fixed app access declaration and scaffold new packages with the safe viewer default plus explicit deny support.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | INSTALLER-GAPS CORE-05: validate executable package smoke declarations and their confined static fixtures before install.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | APP-02: require structurally valid store audit bindings, warn without claiming verification in compatible mode, and install fully evidenced packages from their exact audited SHA in enforce mode.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Validate package-owned Takeout declarations before install and verify their named handler exports during route compilation.
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Validate first-class manifest schedules before install, including service-route ownership/auth, named handler exports, and static bounded bodies.
 *
 * The npm-of-OSHAL-apps helper. An OSHAL app package is a folder with a definition
 * file (oshal-app.yaml — the package.json analog), personas, compiled routes, migrations,
 * ui, and tools. This CLI is the authoring toolchain:
 *
 *   node scripts/oshal-app.js init <name> [--dir <parent>]   # scaffold a new package
 *   node scripts/oshal-app.js validate <package-dir>         # lint a package (ADR-085 contract)
 *
 * `validate` exits non-zero on any error, so it doubles as a CI gate for a store repo.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const { validateSmokeDeclarations } = require('./oshal-app-smoke');
const { validateTakeoutDeclarations } = require('./oshal-app-takeout');
const { validateScheduleDeclarations } = require('./oshal-app-schedules');
const {
  loadPackageAuditAssessment,
  resolvePackageAuditMode,
} = require('./oshal-package-audit');

// The default app store: the PUBLIC store, the same one scripts/oshal-install.sh downloads and
// the only one a deployment without OSHAL_STORE_TOKEN can read. Pointing this at the private
// trunk made `install <name>` fail for everyone outside the org while the shell installer
// succeeded from the public snapshot. The trunk is reachable by setting the store explicitly.
// (git host is irrelevant — any git-subdir source works.)
const DEFAULT_STORE_REPO = 'https://github.com/emeraldcoastsystemsgroup/oshal-apps';

// Registered cockpit skins a package may select via `theme:` (mirror of COCKPIT_THEMES in
// src/pages/cockpit/js/theme-manager.js — keep in sync; a package may also ship a bundled ui/*.css).
const COCKPIT_THEMES = ['midnight', 'daylight', 'ocean', 'sakura', 'forest', 'gray', 'black', 'light-blue', 'aurora', 'graphite', 'amber', 'little-monsters'];

// ADR-118 is deliberately a closed four-word industry ladder. Changing this is an ADR-level
// compatibility event, so the standalone package CLI repeats it to reject bad packages BEFORE
// install; the server loader remains the runtime authority.
const APP_ACCESS_TIERS = ['deny', 'viewer', 'editor', 'admin'];

// Framework directories a package path must NEVER reference — a package must be self-contained
// (ADR-085): every path in the manifest resolves inside the package, never back into the monolith.
const FRAMEWORK_DIRS = ['src/', 'ai-lab/', 'any-bot/', 'scripts/', 'config-seed/', 'swarm-apps/'];

const C = { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };

/** True when a manifest path escapes the package (absolute, parent-traversal, or a framework dir). */
function escapesPackage(p) {
  if (typeof p !== 'string' || !p) return false;
  if (path.isAbsolute(p)) return true;
  if (p.split(/[\\/]/).includes('..')) return true;
  return FRAMEWORK_DIRS.some((d) => p.replace(/\\/g, '/').startsWith(d));
}

/** Collect a report of { errors, warnings } for a package directory. */
function validatePackage(dir) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  const manifestPath = path.join(dir, 'oshal-app.yaml');
  if (!fs.existsSync(manifestPath)) {
    return { errors: [`No oshal-app.yaml in ${dir} — an app package must have a definition file.`], warnings };
  }
  let m;
  try {
    m = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { errors: [`oshal-app.yaml failed to parse: ${e.message}`], warnings };
  }
  if (!m || typeof m !== 'object') return { errors: ['oshal-app.yaml is empty or not a mapping.'], warnings };

  // ── identity ──────────────────────────────────────────────────────────────
  if (!m.name) err('missing required field: name');
  else if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(m.name)) err(`name "${m.name}" must be a slug (lowercase, digits, dashes; 2-64 chars)`);
  if (!m.displayName) err('missing required field: displayName');
  // ADR-097 — suite (the app's ONE primary catalog shelf). Shape only: the authoritative VALUE
  // check is fail-closed server-side (swarm-app-loader against SWARM_APP_SUITES) — re-listing the
  // enum here would be a second source of truth that drifts (same reasoning as `uses:` below).
  if (m.suite === undefined) warn('no suite — the app boots but lists under "More"; declare its ONE primary catalog shelf (ADR-097)');
  else if (typeof m.suite !== 'string' || !m.suite.trim()) err('suite, when present, must be a non-empty string (ADR-097 catalog shelf)');
  if (!m.version) warn('no version — recommended (semver, e.g. 1.0.0)');
  if (!m.source) warn('no source block — the installer stamps provenance from source: {type: git-subdir, url, path, ref}');
  else if (m.source.type !== 'git-subdir') warn(`source.type "${m.source.type}" — only "git-subdir" is supported today`);

  // ── self-containment: no path may escape the package ────────────────────────
  const pathFields = [];
  (m.bots || []).forEach((b, i) => pathFields.push([`bots[${i}].persona`, b.persona]));
  if (m.foundation) pathFields.push(['foundation.persona', m.foundation.persona]);
  (m.routes || []).forEach((r, i) => pathFields.push([`routes[${i}].module`, r.module]));
  (m.migrations || []).forEach((mig, i) => pathFields.push([`migrations[${i}]`, mig]));
  if (m.sharedCss) pathFields.push(['sharedCss', m.sharedCss]);
  if (m.toolsDir) pathFields.push(['toolsDir', m.toolsDir]);
  for (const [field, p] of pathFields) {
    if (escapesPackage(p)) err(`${field}: "${p}" escapes the package — packages must be self-contained (no src/, ai-lab/, any-bot/, absolute, or ../ paths)`);
  }

  // ── referenced files must exist in the package ──────────────────────────────
  const mustExist = [];
  (m.bots || []).forEach((b, i) => b.persona && mustExist.push([`bots[${i}].persona`, b.persona]));
  if (m.foundation && m.foundation.persona) mustExist.push(['foundation.persona', m.foundation.persona]);
  (m.migrations || []).forEach((mig, i) => mustExist.push([`migrations[${i}]`, mig]));
  if (m.sharedCss) mustExist.push(['sharedCss', m.sharedCss]);
  for (const [field, p] of mustExist) {
    if (!escapesPackage(p) && !fs.existsSync(path.join(dir, p))) err(`${field}: file not found in package: ${p}`);
  }
  // routes are COMPILED JS — may not exist until the build runs → warn, not error.
  (m.routes || []).forEach((r, i) => {
    if (r.module && !escapesPackage(r.module) && !fs.existsSync(path.join(dir, r.module))) {
      warn(`routes[${i}].module not present yet: ${r.module} — compile it into the package (see BUILD.md) before install`);
    }
  });

  // ── bots: agentIds present + unique within the package ──────────────────────
  const ids = (m.bots || []).map((b) => b.agentId).filter(Boolean);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) err(`duplicate agentId(s) within the package: ${[...new Set(dupes)].join(', ')}`);
  (m.bots || []).forEach((b, i) => {
    if (!b.agentId) err(`bots[${i}] (${b.name || '?'}) missing agentId`);
    if (!b.persona) warn(`bots[${i}] (${b.name || '?'}) has no persona`);
    // ADR-085 D3 — shape only. The authoritative ROLE check is fail-closed server-side
    // (readManifest, against @/shared/types/access-roles); re-listing the roles here would be a
    // second source of truth that drifts (same reasoning as `uses:` and `routes[].auth`).
    if (b.accessRoles !== undefined) {
      if (!Array.isArray(b.accessRoles) || b.accessRoles.length === 0) {
        err(`bots[${i}] (${b.name || '?'}) accessRoles, when present, must be a NON-EMPTY array of caller roles — omit the key to leave the bot open to every caller`);
      } else if (b.accessRoles.some((r) => typeof r !== 'string')) {
        err(`bots[${i}] (${b.name || '?'}) accessRoles must contain only strings`);
      }
    }
  });

  // ── dependencies well-formed ────────────────────────────────────────────────
  if (m.dependencies) {
    for (const k of ['apps', 'tools', 'connectors']) {
      if (m.dependencies[k] !== undefined && !Array.isArray(m.dependencies[k])) err(`dependencies.${k} must be an array`);
    }
  }

  // ── routes: auth (ADR-085 D2) ──────────────────────────────────────────────
  // Shape + loud warnings only. The AUTHORITATIVE mode check is fail-closed server-side
  // (readManifest, against @/shared/route-auth) — re-listing the mode enum in this JS CLI would be
  // a second source of truth that drifts (same reasoning as `uses:` below).
  if (m.routes !== undefined) {
    if (!Array.isArray(m.routes)) err('routes must be an array');
    else m.routes.forEach((r, i) => {
      for (const f of ['module', 'factory', 'mountPath']) {
        if (!r || typeof r[f] !== 'string' || !r[f]) err(`routes[${i}] is missing a non-empty ${f}`);
      }
      if (r && typeof r.mountPath === 'string' && !r.mountPath.startsWith('/')) {
        err(`routes[${i}].mountPath must start with '/'`);
      }
      if (r && r.auth !== undefined && typeof r.auth !== 'string') err(`routes[${i}].auth must be a string`);
      if (r && r.requiresAuth !== undefined && typeof r.requiresAuth !== 'boolean') {
        err(`routes[${i}].requiresAuth must be a boolean`);
      }
      if (r && r.requiresAi !== undefined && typeof r.requiresAi !== 'boolean') {
        err(`routes[${i}].requiresAi must be a boolean`);
      }
      if (r && (r.auth === 'public' || r.requiresAuth === false)) {
        warn(`routes[${i}] (${r.mountPath}) is ANONYMOUS-CALLABLE — confirm the router self-guards (token/HMAC) inside.`);
      }
      if (r && r.auth === undefined && r.requiresAuth === undefined) {
        warn(`routes[${i}] (${r.mountPath}) declares no auth — it defaults to 'oidc'. Declare it explicitly.`);
      }
    });
  }

  // ── smoke: executable package proof (INSTALLER-GAPS CORE-05) ───────────────
  // A separate module keeps this already-large CLI below its file-size trigger. The runtime loader
  // repeats the contract because pre-install lint and activation are independent trust boundaries.
  // Package-owned Takeout handlers load in-process on activation. Validate their literal archive
  // paths and confined compiled modules before an install reaches that trust boundary.
  const takeoutValidation = validateTakeoutDeclarations(m, dir);
  takeoutValidation.errors.forEach(err);
  takeoutValidation.warnings.forEach(warn);

  for (const smokeError of validateSmokeDeclarations(m, dir)) err(smokeError);
  for (const scheduleError of validateScheduleDeclarations(m)) err(scheduleError);

  // ── guestTier: a REQUEST, not a grant (ADR-085 D4) ─────────────────────────
  // Shape only; the authoritative value check is fail-closed server-side (readManifest). Say plainly
  // that declaring it grants nothing — an author who assumes otherwise ships an app they believe is
  // open to guests and it silently is not (or, worse, assumes it is safe and it is not).
  if (m.guestTier !== undefined) {
    if (typeof m.guestTier !== 'string') err('guestTier must be a string');
    else warn(`guestTier: ${m.guestTier} is a REQUEST — an operator must approve it (PATCH /api/swarm/apps/${m.name || '<app>'}/guest-tier) before it affects guests. Until then guests are read-only.`);
  }

  // ── access: per-user platform doorway (ADR-118) ─────────────────────────────
  if (m.access !== undefined) {
    if (!m.access || typeof m.access !== 'object' || Array.isArray(m.access)) {
      err('access must be an object');
    } else {
      const unknownFields = Object.keys(m.access).filter((key) => !['supported', 'defaultTier', 'mappings'].includes(key));
      if (unknownFields.length) err(`access has unknown field(s): ${unknownFields.join(', ')}`);
      if (!Array.isArray(m.access.supported) || m.access.supported.length === 0) {
        err('access.supported must be a non-empty array');
      } else {
        const unknown = m.access.supported.filter((tier) => !APP_ACCESS_TIERS.includes(tier));
        if (unknown.length) err(`access.supported contains unknown tier(s): ${unknown.join(', ')}`);
        if (new Set(m.access.supported).size !== m.access.supported.length) err('access.supported must not contain duplicates');
        if (!m.access.supported.includes('deny')) err('access.supported must include deny');
        if (!APP_ACCESS_TIERS.includes(m.access.defaultTier)) err('access.defaultTier must be deny, viewer, editor, or admin');
        else if (!m.access.supported.includes(m.access.defaultTier)) err('access.defaultTier must also appear in access.supported');
      }
      if (m.access.mappings !== undefined) {
        if (!m.access.mappings || typeof m.access.mappings !== 'object' || Array.isArray(m.access.mappings)) {
          err('access.mappings must be an object when present');
        } else {
          for (const [tier, bundle] of Object.entries(m.access.mappings)) {
            if (!APP_ACCESS_TIERS.includes(tier)) err(`access.mappings contains unknown tier: ${tier}`);
            else if (!Array.isArray(m.access.supported) || !m.access.supported.includes(tier)) err(`access.mappings.${tier} maps an unsupported tier`);
            if (typeof bundle !== 'string' || !bundle.trim()) err(`access.mappings.${tier} must be a non-empty bundle id`);
          }
        }
      }
    }
  }

  // ── uses: kernel skills (ADR-090 D8) ───────────────────────────────────────
  // Shape only. The AUTHORITATIVE id check is fail-closed server-side (readManifest, against
  // @/shared/kernel-skills) and in CI (scripts/check-kernel-skills.ts). Re-listing the skill ids
  // in this JS CLI would be a second source of truth that drifts the moment a skill is added.
  if (m.uses !== undefined) {
    if (!Array.isArray(m.uses)) err('uses must be an array of kernel-skill ids');
    else if (m.uses.some((s) => typeof s !== 'string')) err('uses must contain only strings (kernel-skill ids)');
  }
  // A kernel skill is always present — it is never an installable app. Catching this here saves an
  // author the install-time "dependency not found" hunt (this is exactly what little-monsters had).
  if (m.dependencies && Array.isArray(m.dependencies.apps) && m.dependencies.apps.includes('presentations')) {
    warn("dependencies.apps includes 'presentations' — deck generation is a KERNEL SKILL, not an app dependency. Use `uses: [deck-generation]`.");
  }

  // ── theme: a known skin id, or a bundled ui/*.css ───────────────────────────
  if (m.theme && !COCKPIT_THEMES.includes(m.theme)) {
    const bundled = fs.existsSync(path.join(dir, 'ui', `${m.theme}.css`)) || (m.sharedCss && fs.existsSync(path.join(dir, m.sharedCss)));
    if (!bundled) warn(`theme "${m.theme}" is not a known cockpit skin and no bundled ui css matches — the cockpit will fall back to the default skin`);
  }

  return { errors, warnings };
}

/** Print a validation report and return the process exit code. */
function reportValidation(dir, { errors, warnings }) {
  const rel = path.resolve(dir);
  console.log(C.bold(`\noshal-app validate  ${C.dim(rel)}`));
  for (const w of warnings) console.log(`  ${C.yellow('warn')}  ${w}`);
  for (const e of errors) console.log(`  ${C.red('error')} ${e}`);
  if (!errors.length && !warnings.length) console.log(`  ${C.green('ok')}    package is valid`);
  console.log('');
  console.log(errors.length ? C.red(`✗ ${errors.length} error(s), ${warnings.length} warning(s)`) : C.green(`✓ valid  ${C.dim(`(${warnings.length} warning(s))`)}`));
  return errors.length ? 1 : 0;
}

const STARTER_MANIFEST = (name) => `# OSHAL app package — ${name}
# Definition file (the package.json analog). Every path below is RELATIVE TO THIS
# PACKAGE. See docs/apps/authoring-app-packages.md and ADR-085.

name: ${name}
# ADR-097: the app's ONE primary catalog shelf. Value is validated FAIL-CLOSED at load
# (SWARM_APP_SUITES in the framework); missing only warns and the app lists under "More".
suite: ai-productivity
displayName: ${name}
description: >-
  One-line description of what this app does.
version: 1.0.0
status: active
scope: person

# ADR-118: the platform-wide per-user doorway. Package capabilities remain authoritative
# after editor/admin enters; omission preserves legacy behavior for older packages.
access:
  supported: [deny, viewer, editor, admin]
  defaultTier: viewer

source:
  type: git-subdir
  url: https://github.com/<org>/<store-repo>
  path: ${name}
  ref: main

# Dependencies. TODAY the installer resolves \`apps\` only (fail-closed);
# \`tools\`/\`connectors\` are declarative (tools: not yet verified/ref-counted —
# BACKLOG D11; connectors: ALSO the app's runtime connector allow-list —
# [] means this app's surfaces never offer account connections).
dependencies:
  apps: []
  tools: []
  connectors: []

# RAG collections this app OWNS (glob prefixes). Surfaced in uninstall-impact;
# deleted at uninstall only under the operator's explicit ?dropData=true.
ragCollections: []

# Typed, per-app settings surfaced in the app's settings panel.
settings:
  schema: {}

# This app's bots. agentIds must be unique and NOT owned by another installed app.
bots: []

# NEW tools this app provides (compiled JS under tools/).
toolsDir: tools/

# Ribbon/toolbar surfaces.
ui:
  static: []

# Compiled-JS routes, mounted in-process at activation (see routes/README.md + BUILD.md).
routes: []

# This app's own schema, applied idempotently on install.
migrations: []

# A registered cockpit skin id, or a bundled ui/*.css.
theme: midnight
`;

const README = (name) => `# ${name} — an OSHAL app package\n\nScaffolded by \`oshal-app init\`. Fill in \`oshal-app.yaml\`, add personas/, routes/, tools/,\nmigrations/, ui/, then \`node scripts/oshal-app.js validate ${name}\`.\n`;

/** Scaffold a new package directory. */
function initPackage(name, parentDir) {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) {
    console.error(C.red(`name "${name}" must be a slug (lowercase, digits, dashes; 2-64 chars)`));
    return 1;
  }
  const dir = path.resolve(parentDir || process.cwd(), name);
  if (fs.existsSync(dir)) {
    console.error(C.red(`refusing to overwrite existing directory: ${dir}`));
    return 1;
  }
  for (const sub of ['personas', 'routes', 'tools', 'ui', 'migrations']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, 'oshal-app.yaml'), STARTER_MANIFEST(name));
  fs.writeFileSync(path.join(dir, 'README.md'), README(name));
  fs.writeFileSync(path.join(dir, 'routes', 'README.md'), 'Compiled-JS Express routes (see BUILD.md). Named + wired by oshal-app.yaml → routes[].\n');
  fs.writeFileSync(path.join(dir, 'tools', 'README.md'), 'Bundled tools discovered at load time (oshal-app.yaml → toolsDir).\n');
  console.log(C.green(`✓ scaffolded package: ${dir}`));
  console.log(C.dim(`  next: edit oshal-app.yaml, then  node scripts/oshal-app.js validate ${path.relative(process.cwd(), dir) || name}`));
  return 0;
}

/** Default install target: the swarm's writable deployed-apps/ (the loader auto-loads it). */
function defaultDeployDir() {
  const root = process.env.CLINE_WORKSPACE_ROOT;
  return root ? path.join(root, 'deployed-apps') : path.resolve(process.cwd(), 'deployed-apps');
}

/**
 * Resolve a package's dependencies.apps (ADR-085 §3): each dep must be (a) already
 * installed in the deploy dir, (b) shipped by the framework (swarm-apps/<dep>.yaml in
 * cwd), or (c) installable from the same store — in which case it is installed
 * recursively. Fail-closed on anything unresolvable. `seen` breaks dependency cycles.
 * Returns the resolution map for provenance, or null on failure.
 */
function resolveDependencies(manifest, opts, seen) {
  const deps = (manifest.dependencies && Array.isArray(manifest.dependencies.apps)) ? manifest.dependencies.apps : [];
  const resolution = {};
  for (const dep of deps) {
    if (seen.has(dep)) { resolution[dep] = 'cycle-already-resolving'; continue; }
    if (fs.existsSync(path.join(opts.destAbs, dep, 'oshal-app.yaml'))) { resolution[dep] = 'installed'; continue; }
    if (fs.existsSync(path.resolve(process.cwd(), 'swarm-apps', `${dep}.yaml`))) { resolution[dep] = 'core'; continue; }
    console.log(C.dim(`  dependency "${dep}" not present — installing from the store …`));
    const rc = installPackage(dep, {
      repo: opts.repo,
      ref: opts.ref,
      dest: opts.destAbs,
      auditMode: opts.auditMode,
    }, seen);
    if (rc !== 0) {
      console.error(C.red(`  unresolved dependency "${dep}" — failing closed (nothing partially enabled).`));
      return null;
    }
    resolution[dep] = 'installed-from-store';
  }
  return resolution;
}

/**
 * Build Git's private-store authentication transport without putting a token in a URL or argv.
 * Git reads the scoped HTTP header from the named environment variable through --config-env.
 */
function buildStoreGitAuth(repo, parent = process.env) {
  const storeToken = (parent.OSHAL_STORE_TOKEN || parent.GITHUB_TOKEN || '').trim();
  const baseEnv = { ...parent };
  delete baseEnv.OSHAL_STORE_TOKEN;
  delete baseEnv.GITHUB_TOKEN;
  delete baseEnv.OSHAL_GIT_AUTH_HEADER;
  if (!storeToken || !/^https:\/\/github\.com\//.test(repo)) {
    return { argsPrefix: [], baseEnv, cloneEnv: baseEnv, storeToken: '' };
  }
  const basic = Buffer.from(`x-access-token:${storeToken}`, 'utf8').toString('base64');
  return {
    argsPrefix: ['--config-env=http.https://github.com/.extraheader=OSHAL_GIT_AUTH_HEADER'],
    baseEnv,
    cloneEnv: { ...baseEnv, OSHAL_GIT_AUTH_HEADER: `Authorization: Basic ${basic}` },
    storeToken,
  };
}

/** Pin a verified package checkout to the audit SHA and prove Git landed on that exact object. */
function pinCheckoutToAudit(git, tmp, assessment) {
  if (!assessment.sourceSha) return;
  const current = git(['-C', tmp, 'rev-parse', 'HEAD']);
  if (current !== assessment.sourceSha) {
    git(['-C', tmp, 'fetch', '--depth', '1', 'origin', assessment.sourceSha], true);
    git(['-C', tmp, 'checkout', '--detach', assessment.sourceSha]);
  }
  const checkedOut = git(['-C', tmp, 'rev-parse', 'HEAD']);
  if (checkedOut !== assessment.sourceSha) {
    throw new Error(`audit SHA checkout mismatch: expected ${assessment.sourceSha}, got ${checkedOut}`);
  }
}

/** Refuse a package whose checked-out manifest does not match the catalog identity under audit. */
function packageIdentityProblems(manifest, assessment) {
  const problems = [];
  if (manifest.name !== assessment.entry.name) problems.push('package manifest name does not match catalog name');
  if (String(manifest.version ?? '') !== String(assessment.entry.version ?? '')) {
    problems.push('package manifest version does not match catalog version');
  }
  return problems;
}

/** Build provenance that never labels an unverified checkout as audit-pinned. */
function auditProvenance(assessment) {
  return {
    mode: assessment.mode,
    status: assessment.record.status,
    verified: assessment.verified,
    record: assessment.entry.audit.record,
    sourceSha: assessment.sourceSha,
    reasons: assessment.reasons,
  };
}

/** Assess one cloned catalog record, report its posture, and pin a verified checkout. */
function acceptAuditAssessment(git, tmp, name, ref, auditMode) {
  const assessment = loadPackageAuditAssessment(tmp, name, auditMode);
  if (!assessment.allowed) {
    console.error(C.red(`refusing to install "${name}" — package audit denied it in ${auditMode} mode:`));
    assessment.reasons.forEach((reason) => console.error(`  ${C.red('error')} ${reason}`));
    return null;
  }
  if (assessment.verified) {
    pinCheckoutToAudit(git, tmp, assessment);
    console.log(C.green(`✓ audit verified ${name}`) + C.dim(`  (${assessment.sourceSha.slice(0, 12)})`));
  } else {
    console.error(C.yellow(`WARNING: ${name} is NOT AUDIT-VERIFIED; compatible mode uses ${ref} and grants no audited SHA pin.`));
    assessment.reasons.forEach((reason) => console.error(`  ${C.yellow('warn')}  ${reason}`));
  }
  return assessment;
}

/** Validate package contents plus their exact catalog name/version identity. */
function readValidatedManifest(src, name, repo, assessment) {
  const manifestPath = path.join(src, 'oshal-app.yaml');
  if (!fs.existsSync(manifestPath)) {
    console.error(C.red(`package "${name}" not found in ${repo} (no ${name}/oshal-app.yaml)`));
    return null;
  }
  const { errors, warnings } = validatePackage(src);
  if (errors.length) {
    console.error(C.red(`refusing to install "${name}" — it failed validation:`));
    errors.forEach((error) => console.error(`  ${C.red('error')} ${error}`));
    return null;
  }
  warnings.forEach((warning) => console.log(`  ${C.yellow('warn')}  ${warning}`));
  const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8')) || {};
  const identityProblems = packageIdentityProblems(manifest, assessment);
  if (!identityProblems.length) return manifest;
  console.error(C.red(`refusing to install "${name}" — audited catalog identity does not match the checkout:`));
  identityProblems.forEach((problem) => console.error(`  ${C.red('error')} ${problem}`));
  return null;
}

/** Atomically replace the package directory and stamp unambiguous source/audit provenance. */
function landInstalledPackage(src, dest, details) {
  const target = path.join(dest, details.name);
  fs.mkdirSync(dest, { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(src, target, { recursive: true });
  fs.writeFileSync(path.join(target, '.oshal-install.json'), JSON.stringify({
    name: details.name, repo: details.repo, ref: details.ref, sha: details.sha,
    installedAt: new Date().toISOString(),
    dependencies: details.resolution,
    audit: auditProvenance(details.assessment),
  }, null, 2));
  console.log(C.green(`✓ installed ${details.name} → ${target}`) + C.dim(`  (${details.sha.slice(0, 8)})`));
  const depNames = Object.keys(details.resolution);
  if (depNames.length) console.log(C.dim(`  deps: ${depNames.map((dep) => `${dep}=${details.resolution[dep]}`).join(', ')}`));
  console.log(C.dim('  the swarm loader auto-loads deployed-apps/ on boot; or hot-load now:'));
  console.log(C.dim(`  curl -X POST localhost:5000/api/swarm/apps/load -H 'content-type: application/json' -d '{"path":"${target.replace(/\\/g, '/')}/oshal-app.yaml"}'`));
  return 0;
}

/**
 * Install a package by name from a git store repo (git-subdir): sparse-clone just that
 * subfolder at the given ref, validate it, RESOLVE ITS DEPENDENCIES (installing missing
 * ones from the same store — npm-style, fail-closed), and copy it into the deploy dir
 * where the swarm loader picks it up. Ad-hoc + repeatable; private-store auth is transported
 * through Git's config-env support so process arguments and the remote URL remain clean.
 */
function installPackage(name, opts, seen) {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) { console.error(C.red(`bad package name: ${name}`)); return 1; }
  seen = seen || new Set();
  seen.add(name);
  const repo = opts.repo || DEFAULT_STORE_REPO;
  const ref = opts.ref || 'main';
  const auditMode = resolvePackageAuditMode(opts.auditMode);
  const dest = path.resolve(opts.dest || defaultDeployDir());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-install-'));
  const storeAuth = buildStoreGitAuth(repo);
  const git = (args, authenticateStore = false) => execFileSync('git', [
    ...(authenticateStore ? storeAuth.argsPrefix : []),
    ...args,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: authenticateStore ? storeAuth.cloneEnv : storeAuth.baseEnv,
  }).toString().trim();
  try {
    console.log(C.dim(`fetching ${name} from ${repo}#${ref} …`));
    git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', '-b', ref, repo, tmp], true);
    git(['-C', tmp, 'sparse-checkout', 'set', '--no-cone', 'marketplace.json', `audits/${name}.json`, name]);
    const assessment = acceptAuditAssessment(git, tmp, name, ref, auditMode);
    if (!assessment) return 1;
    const src = path.join(tmp, name);
    const manifest = readValidatedManifest(src, name, repo, assessment);
    if (!manifest) return 1;
    const resolution = resolveDependencies(manifest, { repo, ref, destAbs: dest, auditMode }, seen);
    if (resolution === null) return 1;

    const sha = git(['-C', tmp, 'rev-parse', 'HEAD']);
    return landInstalledPackage(src, dest, { name, repo, ref, sha, resolution, assessment });
  } catch (e) {
    const msg = storeAuth.storeToken ? e.message.split(storeAuth.storeToken).join('***') : e.message;
    console.error(C.red(`install failed: ${msg.split('\n')[0]}`));
    return 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Build a package's routes: compile src-routes/*.ts against an OSHAL framework checkout
 * (which supplies tsc + the @/ type graph) into routes/*.js with @/ imports PRESERVED
 * (no tsc-alias — the swarm's ManifestRouteMounter resolves @/ at runtime).
 *
 * Mechanics (the procedure proven by the little-monsters carve-out, automated):
 *   1. Copy src-routes/*.ts into <framework>/src/app/routes/ (transient; collision-guarded).
 *   2. Run the framework's tsc with --outDir <tmp> (plain emit, keeps @/).
 *   3. Harvest the emitted .js for each copied source into <package>/routes/.
 *   4. Verify: every relative require targets another bundled module (framework imports
 *      must use @/ — the self-containment rule), and each manifest factory is exported.
 *   5. Clean up the transient copies + tmp dir (always, in finally).
 */
function buildPackage(pkgDirInput, opts) {
  const pkgDir = path.resolve(pkgDirInput);
  const fw = path.resolve(opts.framework || process.cwd());
  const srcDir = path.join(pkgDir, 'src-routes');
  const outRoutes = path.join(pkgDir, 'routes');
  if (!fs.existsSync(path.join(pkgDir, 'oshal-app.yaml'))) { console.error(C.red(`no oshal-app.yaml in ${pkgDir}`)); return 1; }
  if (!fs.existsSync(srcDir)) { console.error(C.red(`no src-routes/ in ${pkgDir} — nothing to build`)); return 1; }
  if (!fs.existsSync(path.join(fw, 'tsconfig.json')) || !fs.existsSync(path.join(fw, 'node_modules', 'typescript'))) {
    console.error(C.red(`--framework must point at an OSHAL checkout with node_modules (got ${fw})`));
    return 1;
  }
  const manifest = yaml.load(fs.readFileSync(path.join(pkgDir, 'oshal-app.yaml'), 'utf8')) || {};
  const sources = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
  if (!sources.length) { console.error(C.red('src-routes/ has no .ts files')); return 1; }
  const bundledBases = new Set(sources.map((f) => f.replace(/\.ts$/, '')));

  const fwRoutes = path.join(fw, 'src', 'app', 'routes');
  const copied = [];
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-build-'));
  try {
    // 1. transient copy (collision-guarded: never overwrite a framework file)
    for (const f of sources) {
      const destFile = path.join(fwRoutes, f);
      if (fs.existsSync(destFile)) {
        console.error(C.red(`collision: ${f} already exists in the framework checkout — refusing to overwrite`));
        return 1;
      }
      fs.copyFileSync(path.join(srcDir, f), destFile);
      copied.push(destFile);
    }
    // 2. plain tsc emit (NO tsc-alias → @/ preserved)
    console.log(C.dim(`compiling ${sources.length} source(s) against ${fw} …`));
    execFileSync(process.execPath, [path.join(fw, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json', '--outDir', tmpOut], { cwd: fw, stdio: ['ignore', 'pipe', 'pipe'] });
    // 3. harvest
    fs.mkdirSync(outRoutes, { recursive: true });
    let built = 0;
    for (const base of bundledBases) {
      const emitted = path.join(tmpOut, 'app', 'routes', `${base}.js`);
      if (!fs.existsSync(emitted)) { console.error(C.red(`tsc emitted no ${base}.js`)); return 1; }
      fs.copyFileSync(emitted, path.join(outRoutes, `${base}.js`));
      built++;
    }
    // 4. verify self-containment + factories
    const problems = [];
    for (const base of bundledBases) {
      const js = fs.readFileSync(path.join(outRoutes, `${base}.js`), 'utf8');
      for (const m of js.matchAll(/require\("\.\/([^"]+)"\)/g)) {
        if (!bundledBases.has(m[1])) problems.push(`${base}.js requires "./${m[1]}" which is NOT bundled — import framework modules via @/`);
      }
    }
    for (const r of manifest.routes || []) {
      const base = String(r.module || '').replace(/^routes\//, '').replace(/\.js$/, '');
      if (!bundledBases.has(base)) continue; // module not built from src-routes
      const js = fs.readFileSync(path.join(outRoutes, `${base}.js`), 'utf8');
      if (r.factory && !js.includes(r.factory)) problems.push(`${base}.js does not export declared factory ${r.factory}`);
    }
    for (const declaration of manifest.takeout || []) {
      const base = String(declaration.module || '').replace(/^routes\//, '').replace(/\.js$/, '');
      if (!bundledBases.has(base)) continue;
      const js = fs.readFileSync(path.join(outRoutes, `${base}.js`), 'utf8');
      if (declaration.handler && !js.includes(declaration.handler)) {
        problems.push(`${base}.js does not export declared Takeout handler ${declaration.handler}`);
      }
    }
    for (const declaration of manifest.schedules || []) {
      if (declaration.target !== 'service-route') continue;
      const owner = (manifest.routes || [])
        .filter((route) => {
          const mount = String(route.mountPath || '').replace(/\/+$/, '');
          return declaration.route === mount || declaration.route.startsWith(`${mount}/`);
        })
        .sort((a, b) => String(b.mountPath).length - String(a.mountPath).length)[0];
      const base = String(owner && owner.module || '').replace(/^routes\//, '').replace(/\.js$/, '');
      if (!base || !bundledBases.has(base)) continue;
      const js = fs.readFileSync(path.join(outRoutes, `${base}.js`), 'utf8');
      if (declaration.handler && !js.includes(declaration.handler)) {
        problems.push(`${base}.js does not export declared schedule handler ${declaration.handler}`);
      }
    }
    if (problems.length) {
      problems.forEach((p) => console.error(`  ${C.red('error')} ${p}`));
      return 1;
    }
    console.log(C.green(`✓ built ${built} route module(s) → ${outRoutes}`) + C.dim('  (@/ imports preserved for runtime alias resolution)'));
    return 0;
  } catch (e) {
    const detail = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    console.error(C.red(`build failed: ${e.message.split('\n')[0]}`));
    if (detail) console.error(C.dim(detail.split('\n').slice(0, 12).join('\n')));
    return 1;
  } finally {
    for (const f of copied) fs.rmSync(f, { force: true });
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
}

/**
 * Uninstall an installed package from the deploy dir — DEPENDENCY-AWARE (ADR-085 §5 + D11):
 * blocked while another installed package's manifest (or install stamp) depends on it,
 * OR names one of its provided tools in dependencies.tools (tool dependents block exactly
 * like app dependents — the server's uninstall-impact rule, mirrored here);
 * orphaned dependencies are REPORTED, never auto-removed; requires --yes (impact shown
 * first). Schema is never dropped — if the package ships migrations/uninstall.sql the
 * command prints how to apply it (explicit opt-in, data-loss gate).
 */
function uninstallPackage(name, opts) {
  const dest = path.resolve(opts.dest || defaultDeployDir());
  const target = path.join(dest, name);
  if (!fs.existsSync(path.join(target, 'oshal-app.yaml'))) {
    console.error(C.red(`"${name}" is not installed in ${dest}`));
    return 1;
  }
  // Impact: scan the OTHER installed packages' declared deps — apps AND tools, mirroring
  // the SERVER's semantics (SwarmAppService.uninstallImpact / tool-ownership.ts). The CLI
  // scans the deploy dir (its offline view) where the server scans the ACTIVE registry rows;
  // what counts as provided/depended and what BLOCKS is byte-for-byte the same rule.
  const readManifestObj = (dir) => {
    try { return yaml.load(fs.readFileSync(path.join(dir, 'oshal-app.yaml'), 'utf8')) || {}; } catch { return {}; }
  };
  const readDeps = (dir) => {
    const m = readManifestObj(dir);
    return (m.dependencies && Array.isArray(m.dependencies.apps)) ? m.dependencies.apps : [];
  };
  // D11 server parity: PROVIDED = the manifest's tools[].name ONLY — deliberately NOT
  // ui.static[].toolName (ribbon surface ids, not registry tools; the server's
  // providedToolNames() draws the same line). DEPENDED = dependencies.tools.
  const providedTools = (dir) => {
    const m = readManifestObj(dir);
    return (Array.isArray(m.tools) ? m.tools : []).map((t) => t && t.name).filter(Boolean);
  };
  const dependedTools = (dir) => {
    const m = readManifestObj(dir);
    return (m.dependencies && Array.isArray(m.dependencies.tools)) ? m.dependencies.tools : [];
  };
  const provided = new Set(providedTools(target));
  const dependents = [];
  const toolDependents = []; // [{ app, tools }] — same shape as the server's computeToolDependents
  for (const entry of fs.readdirSync(dest)) {
    if (entry === name) continue;
    const dir = path.join(dest, entry);
    if (!fs.existsSync(path.join(dir, 'oshal-app.yaml'))) continue;
    if (readDeps(dir).includes(name)) dependents.push(entry);
    const overlap = provided.size ? dependedTools(dir).filter((t) => provided.has(t)) : [];
    if (overlap.length) toolDependents.push({ app: entry, tools: overlap });
  }
  const myDeps = readDeps(target);
  const orphans = myDeps.filter((dep) =>
    fs.existsSync(path.join(dest, dep, 'oshal-app.yaml')) && // only installed packages can orphan
    !fs.readdirSync(dest).some((e) => e !== name && e !== dep && fs.existsSync(path.join(dest, e, 'oshal-app.yaml')) && readDeps(path.join(dest, e)).includes(dep)),
  );

  console.log(C.bold(`\nuninstall impact — ${name}`));
  console.log(`  dependents: ${dependents.length ? C.red(dependents.join(', ')) : C.green('none')}`);
  console.log(`  tools provided: ${provided.size ? [...provided].join(', ') : C.dim('none')}`);
  console.log(`  tool dependents: ${toolDependents.length ? C.red(toolDependents.map((d) => `${d.app} needs tool(s) ${d.tools.join(', ')}`).join('; ')) : C.green('none')}`);
  console.log(`  would-be orphans (NOT auto-removed): ${orphans.length ? C.yellow(orphans.join(', ')) : C.dim('none')}`);
  // A tool dependent BLOCKS exactly like an app-level dependent (server rule). It never causes
  // the tool to be RETAINED — under --force the tool goes with its owner; a dangling dependency
  // is the dependent's problem, a dangling executor would be everyone's.
  if ((dependents.length || toolDependents.length) && !opts.force) {
    const parts = [];
    if (dependents.length) parts.push(`${dependents.join(', ')} depend(s) on ${name}`);
    if (toolDependents.length) parts.push(toolDependents.map((d) => `${d.app} needs tool(s) ${d.tools.join(', ')}`).join('; '));
    console.error(C.red(`\n✗ blocked: ${parts.join('; ')}. Remove them first or pass --force.`));
    return 1;
  }
  if (!opts.yes) {
    console.error(C.yellow(`\nre-run with --yes to remove ${target} (folder only — the swarm registry row is removed via DELETE /api/swarm/apps/${name}).`));
    return 1;
  }
  const hasTeardown = fs.existsSync(path.join(target, 'migrations', 'uninstall.sql'));
  fs.rmSync(target, { recursive: true, force: true });
  console.log(C.green(`✓ removed ${target}`));
  console.log(C.dim(`  registry row: curl -X DELETE localhost:5000/api/swarm/apps/${name}   (409s with the impact if server-side dependents exist)`));
  if (hasTeardown) console.log(C.yellow(`  schema kept (data-loss gate). To drop it explicitly the package shipped migrations/uninstall.sql — apply it via psql AFTER backing up.`));
  orphans.forEach((o) => console.log(C.dim(`  orphan candidate: ${o} — remove separately with: oshal-app uninstall ${o}`)));
  return 0;
}

function usage() {
  console.log(`${C.bold('oshal-app')} — OSHAL app-package authoring helper (ADR-085)

  ${C.bold('init')} <name> [--dir <parent>]        scaffold a new app package
  ${C.bold('validate')} <package-dir>               lint a package against the app-package contract
  ${C.bold('install')} <name> [--repo <url>] [--ref <ref>] [--dest <dir>]
                                    [--audit-mode compatible|enforce]
                                    pull a package from a git store repo (git-subdir) into
                                    deployed-apps/ where the swarm loader picks it up —
                                    resolving dependencies.apps npm-style and enforcing
                                    the store audit policy (default: compatible)
  ${C.bold('build')} <package-dir> [--framework <oshal checkout>]
                                    compile the package's src-routes/*.ts → routes/*.js
                                    against a framework checkout, @/ imports preserved
  ${C.bold('uninstall')} <name> [--dest <dir>] [--yes] [--force]
                                    dependency-aware removal: shows the impact (dependents
                                    block; orphans reported, never auto-removed); schema kept

Examples:
  node scripts/oshal-app.js init my-app
  node scripts/oshal-app.js validate ../oshal-applications/little-monsters
  node scripts/oshal-app.js install hello-oshal            # from the default store
  node scripts/oshal-app.js install little-monsters --dest ./deployed-apps
`);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'validate') {
    const dir = rest[0];
    if (!dir) { console.error(C.red('validate needs a package directory')); return 1; }
    if (!fs.existsSync(dir)) { console.error(C.red(`no such directory: ${dir}`)); return 1; }
    return reportValidation(dir, validatePackage(dir));
  }
  if (cmd === 'init') {
    const name = rest.find((a) => !a.startsWith('--'));
    const dirFlag = rest.indexOf('--dir');
    const parent = dirFlag >= 0 ? rest[dirFlag + 1] : undefined;
    if (!name) { console.error(C.red('init needs a package name')); return 1; }
    return initPackage(name, parent);
  }
  if (cmd === 'install') {
    const name = rest.find((a) => !a.startsWith('--'));
    const flag = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
    if (!name) { console.error(C.red('install needs a package name')); return 1; }
    return installPackage(name, {
      repo: flag('--repo'),
      ref: flag('--ref'),
      dest: flag('--dest'),
      auditMode: flag('--audit-mode'),
    });
  }
  if (cmd === 'build') {
    const dir = rest.find((a) => !a.startsWith('--'));
    const flag = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
    if (!dir) { console.error(C.red('build needs a package directory')); return 1; }
    return buildPackage(dir, { framework: flag('--framework') });
  }
  if (cmd === 'uninstall') {
    const name = rest.find((a) => !a.startsWith('--'));
    const flag = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
    if (!name) { console.error(C.red('uninstall needs a package name')); return 1; }
    return uninstallPackage(name, { dest: flag('--dest'), yes: rest.includes('--yes'), force: rest.includes('--force') });
  }
  usage();
  return cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(C.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

module.exports = { buildStoreGitAuth, installPackage };
