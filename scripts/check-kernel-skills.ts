/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085/ADR-090 D8: the kernel-skills CI guard. Asserts every skill the kernel PROMISES packages (@/shared/kernel-skills) is actually re-exported by the build anchor and actually present in the built image. This is the guard that turns the google-calendar/notifications silent-prune class of bug into a red CI run instead of a mount-time failure inside a customer's installed app.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045/ADR-090 closure — PHASE 3, the PACKAGE side of the same contract. Phases 1-2 prove the kernel keeps its promises; nothing proved a package DECLARES what it imports. swarm-app-loader validates a `uses:` list when present but never requires one (the check is guarded on `uses !== undefined`), so five installed packages imported a kernel skill invisibly — exactly the state where a future prune breaks an app with no gate having gone red. Phase 3 scans each store package's COMPILED js for the declared kernel specifiers and asserts the skill id appears in its `uses:`. Lives here rather than in validate-manifests.ts because the specifier→skill-id mapping IS this file's subject (validate-manifests owns manifest/persona SHAPE for the in-repo dirs and never looks at a sibling checkout). Rule is declaration SUPERSET-OF imports, never equality — dnd and game-show legitimately over-declare. Scans .js and NEVER .ts: type-only imports are erased at compile time, so a .ts scan makes trading a false positive on its `import type` from @/features/scheduling.
 */

/**
 * @description Kernel-skill contract guard (ADR-085 Tier-0b / ADR-090 D8).
 *
 * Two phases, because the two failure modes are different:
 *
 *  **Phase 1 — source (no build needed).** For every module in `KERNEL_SKILLS`: its source file
 *  exists, and `src/app/composition/kernel-skills.ts` re-exports it. The re-export is the ONLY
 *  thing that pins a feature into `dist/` (tsconfig.server.json excludes `src/features/**`), so a
 *  skill declared-but-not-anchored is a skill that will be silently pruned.
 *
 *  **Phase 2 — artifact.** Every declared `distFile` is present in the built output: `--dist [root]`
 *  checks a local build, `--image <tag>` checks inside the Docker image that would actually ship.
 *  This is the literal done-when from the backlog: the guard fails if a skill goes missing.
 *
 *  **Phase 3 — the PACKAGE side (declaration ⊇ imports).** For every store package: whichever kernel
 *  skills its COMPILED js actually imports must appear in its manifest `uses:`. Phases 1-2 hold the
 *  kernel to its promises; this holds packages to declaring what they rely on, which is what makes
 *  the promise checkable in the first place. Runs only when a store checkout is present (`--store`,
 *  `OSHAL_STORE_DIR`, or the conventional sibling) and says loudly when it is not.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/check-kernel-skills.ts
 *   … --dist .            # also assert ./dist/** after a local server build
 *   … --image oshal-ci:latest   # also assert /app/dist/** inside the image
 *   … --store ../oshal-applications   # point Phase 3 at a specific store checkout
 *
 * Exit 0 = contract holds. Exit 1 = a package that imports the named skill would fail at mount.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import { KERNEL_SKILLS, type KernelSkillModule } from '@/shared/kernel-skills';

// CHANGE LOG ADDENDUM
// 3 | maintainer@emeraldcoastsystemsgroup.com | Guard first-party package runtime pins that are intentionally not public kernel skills. Spaces imports the drone simulator and CLI-token issuer from the running framework; source anchors and built-image artifacts are mandatory so a future carve cannot prune either dependency silently.

const REPO_ROOT = path.resolve(__dirname, '..');
const ANCHOR_REL = 'src/app/composition/kernel-skills.ts';
/** Where the image's build root lives — the Dockerfile's WORKDIR. */
const IMAGE_ROOT = '/app';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const distRoot = readFlag('--dist');
const imageTag = readFlag('--image');
const storeFlag = readFlag('--store');

const failures: string[] = [];

/**
 * First-party package imports that must remain in the shipped framework but must not be promoted
 * into the public `uses:` vocabulary. Drone is a kernel-owned node capability, while CLI-token
 * issuance is a privileged control-plane API; describing either as a generally callable skill
 * would widen the package contract. These narrow pins make the actual Spaces dependency explicit.
 */
const PACKAGE_RUNTIME_PINS = [
  {
    consumer: 'spaces',
    specifier: '@/features/drone',
    anchorRel: 'src/app/drone-node-server.ts',
    anchorSpecifier: '@/features/drone',
    distFile: 'dist/features/drone/index.js',
  },
  {
    consumer: 'spaces',
    specifier: '@/app/routes/cli-token-routes',
    anchorRel: 'src/app/server.ts',
    anchorSpecifier: './routes/cli-token-routes',
    distFile: 'dist/app/routes/cli-token-routes.js',
  },
] as const;

/**
 * @description Read a `--flag value` pair from argv.
 * @param name - The flag, including leading dashes.
 * @returns The value, or undefined when the flag is absent. A valueless flag defaults to '.'.
 */
function readFlag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return !v || v.startsWith('--') ? '.' : v;
}

/**
 * @description Map a package-facing import specifier to its source file on disk.
 *
 * Packages write `@/features/rag`; that is `src/features/rag/index.ts` (a barrel) or, for a
 * single-file module like the storage-target layer, `src/app/routes/storage-target.ts`.
 *
 * @param specifier - The `@/…` specifier a package imports.
 * @returns The resolved source path, or null when neither shape exists.
 */
function resolveSource(specifier: string): string | null {
  const rel = specifier.replace(/^@\//, 'src/');
  for (const candidate of [`${rel}.ts`, `${rel}/index.ts`]) {
    if (fs.existsSync(path.join(REPO_ROOT, candidate))) return candidate;
  }
  return null;
}

/** @description Log unless --quiet. @param msg - Line to print. */
function say(msg: string): void {
  if (!quiet) console.log(msg);
}

/** @description Print regardless of --quiet. A skipped gate must be visible in a quiet CI log. @param msg - Line to print. */
function shout(msg: string): void {
  console.log(msg);
}

// ── Phase 3 helpers: which kernel skill does an import specifier belong to? ─────────────────
/** Every declared kernel specifier, longest first, so `@/features/personal-graph` can never be
 *  mistaken for a prefix hit on `@/features/personal-data`. */
const SPECIFIER_TO_SKILL: ReadonlyArray<{ specifier: string; skill: string }> = KERNEL_SKILLS.flatMap(
  (s) => s.modules.map((m) => ({ specifier: m.specifier, skill: s.id })),
).sort((a, b) => b.specifier.length - a.specifier.length);

/**
 * @description Map one import specifier to the kernel skill it reaches, if any.
 *
 * A DEEP import counts: a package writing `@/features/graph/services/graph-keys` depends on the
 * graph skill just as much as one importing the barrel, and the prune that would break it is the
 * same prune. The `/` boundary is what keeps sibling slices with a shared prefix apart.
 *
 * @param specifier - The module specifier as written in the compiled js.
 * @returns The kernel-skill id, or null when the specifier is not a kernel module.
 */
function skillForSpecifier(specifier: string): string | null {
  for (const entry of SPECIFIER_TO_SKILL) {
    if (specifier === entry.specifier || specifier.startsWith(`${entry.specifier}/`)) return entry.skill;
  }
  return null;
}

/** Matches `require("…")` and `from "…"` in compiled js, either quote style. */
const SPECIFIER_RE = /require\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]/g;

/**
 * @description List every .js file in a package, skipping vendored dependencies.
 *
 * COMPILED js only, never .ts — TypeScript erases `import type`, so a .ts scan reports a
 * type-only reference (trading's `import type { ScheduleRecord } from '@/features/scheduling'`)
 * as a runtime dependency the package must declare. It isn't one: nothing is required at runtime.
 *
 * @param dir - Directory to walk.
 * @returns Absolute paths of every .js file beneath it, node_modules excluded.
 */
function packageJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...packageJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * @description Read a store package manifest's `uses:` list.
 * @param manifestPath - Path to the package's oshal-app.yaml.
 * @returns The declared kernel-skill ids (empty when the key is absent or malformed).
 */
function declaredUses(manifestPath: string): Set<string> {
  const parsed = yaml.load(fs.readFileSync(manifestPath, 'utf8')) as { uses?: unknown } | null;
  const uses = parsed?.uses;
  if (!Array.isArray(uses)) return new Set();
  return new Set(uses.filter((u): u is string => typeof u === 'string'));
}

/**
 * @description Phase 3 — assert every store package DECLARES the kernel skills it imports.
 *
 * The loader validates a `uses:` list when one is present but never requires it, and it must stay
 * that way: `readManifest` runs at mount on live boxes, so throwing there would fail-closed the
 * already-installed packages. This is where the requirement belongs — a gate, before it ships.
 *
 * The rule is SUPERSET, not equality: a package may declare a skill it no longer imports (dnd and
 * game-show do). Only an UNDECLARED import is a failure, because that is the one a prune breaks.
 *
 * @param storeDir - Root of the store checkout (contains one directory per package).
 * @returns Nothing; violations are appended to `failures`.
 */
function checkStorePackages(storeDir: string): void {
  let scanned = 0;
  for (const entry of fs.readdirSync(storeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const pkgDir = path.join(storeDir, entry.name);
    const manifest = path.join(pkgDir, 'oshal-app.yaml');
    if (!fs.existsSync(manifest)) continue;
    scanned += 1;

    const imported = new Map<string, string>(); // skill id → the file that proves it
    const runtimeSpecifiers = new Set<string>();
    for (const file of packageJsFiles(pkgDir)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(SPECIFIER_RE)) {
        const specifier = m[1] ?? m[2] ?? '';
        runtimeSpecifiers.add(specifier);
        const skill = skillForSpecifier(specifier);
        if (skill && !imported.has(skill)) imported.set(skill, path.relative(storeDir, file));
      }
    }

    const declared = declaredUses(manifest);
    const undeclared = [...imported.keys()].filter((s) => !declared.has(s)).sort();
    if (undeclared.length) {
      failures.push(
        `store package '${entry.name}': imports kernel skill(s) it does not declare: ` +
          `${undeclared.map((s) => `${s} (${imported.get(s)})`).join(', ')}. ` +
          `Add them to \`uses:\` in ${entry.name}/oshal-app.yaml — docs/apps/kernel-skills.md: ` +
          `"declare what your code actually imports". An undeclared import is invisible to the ` +
          `prune guard, so the first carve that drops the skill breaks this app at MOUNT time.`,
      );
    }

    for (const pin of PACKAGE_RUNTIME_PINS.filter((candidate) => candidate.consumer === entry.name)) {
      const importedPin = [...runtimeSpecifiers].some(
        (specifier) => specifier === pin.specifier || specifier.startsWith(`${pin.specifier}/`),
      );
      if (!importedPin) {
        failures.push(
          `store package '${entry.name}': expected pinned runtime import ${pin.specifier} was not ` +
            `found in compiled JavaScript. Remove or update its PACKAGE_RUNTIME_PINS contract ` +
            `instead of leaving a stale build promise.`,
        );
      }
    }
  }
  say(`kernel-skills: scanned ${scanned} store package(s) in ${storeDir} for undeclared kernel imports`);
}

// ── Phase 1: source + anchor ────────────────────────────────────────────────
const anchorPath = path.join(REPO_ROOT, ANCHOR_REL);
if (!fs.existsSync(anchorPath)) {
  failures.push(`build anchor missing: ${ANCHOR_REL} — nothing pins kernel skills into dist/`);
}
const anchorSrc = fs.existsSync(anchorPath) ? fs.readFileSync(anchorPath, 'utf8') : '';

const allModules: Array<KernelSkillModule & { skill: string }> = KERNEL_SKILLS.flatMap((s) =>
  s.modules.map((m) => ({ ...m, skill: s.id })),
);

for (const m of allModules) {
  if (!resolveSource(m.specifier)) {
    failures.push(
      `skill '${m.skill}': declared module ${m.specifier} has no source file — ` +
        `fix the specifier in src/shared/kernel-skills/registry.ts.`,
    );
  }
  // The re-export is the pin. Match `from '<specifier>'` in the anchor.
  const anchored = new RegExp(`from\\s+['"]${m.specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(
    anchorSrc,
  );
  if (!anchored) {
    failures.push(
      `skill '${m.skill}': ${m.specifier} is DECLARED but not re-exported by ${ANCHOR_REL}. ` +
        `Without the re-export tsconfig.server.json prunes it from dist/ and every package ` +
        `importing this skill fails at mount. Add: export * as <ns> from '${m.specifier}';`,
    );
  }
}
say(`kernel-skills: ${KERNEL_SKILLS.length} skills / ${allModules.length} modules declared`);

for (const pin of PACKAGE_RUNTIME_PINS) {
  if (!resolveSource(pin.specifier)) {
    failures.push(
      `package runtime pin '${pin.consumer}': ${pin.specifier} has no source module. Update the ` +
        `package and its explicit pin together.`,
    );
    continue;
  }
  const packageAnchorPath = path.join(REPO_ROOT, pin.anchorRel);
  const packageAnchorSource = fs.existsSync(packageAnchorPath)
    ? fs.readFileSync(packageAnchorPath, 'utf8')
    : '';
  const importsPin = packageAnchorSource.includes(`from '${pin.anchorSpecifier}'`)
    || packageAnchorSource.includes(`from "${pin.anchorSpecifier}"`);
  if (!importsPin) {
    failures.push(
      `package runtime pin '${pin.consumer}': ${pin.anchorRel} no longer imports ${pin.specifier}; ` +
        `the server build can prune ${pin.distFile}.`,
    );
  }
}
say(`kernel-skills: ${PACKAGE_RUNTIME_PINS.length} first-party package runtime pin(s) declared`);

// ── Phase 2: the built artifact ─────────────────────────────────────────────
if (distRoot) {
  const root = path.resolve(REPO_ROOT, distRoot);
  for (const m of allModules) {
    if (!fs.existsSync(path.join(root, m.distFile))) {
      failures.push(
        `skill '${m.skill}': ${m.distFile} MISSING from the build at ${root} — ` +
          `${m.specifier} was pruned. A package importing it would fail at mount.`,
      );
    }
  }
  for (const pin of PACKAGE_RUNTIME_PINS) {
    if (!fs.existsSync(path.join(root, pin.distFile))) {
      failures.push(
        `package runtime pin '${pin.consumer}': ${pin.distFile} MISSING from the build at ${root} - ` +
          `${pin.specifier} was pruned and the installed package would fail at mount.`,
      );
    }
  }
  say(`kernel-skills: checked build root ${root}`);
}

if (imageTag) {
  // One exec, one shell: print every distFile that is NOT present inside the image.
  const probe = [
    ...allModules.map((m) => ({ label: `skill:${m.skill}`, distFile: m.distFile })),
    ...PACKAGE_RUNTIME_PINS.map((pin) => ({ label: `package:${pin.consumer}`, distFile: pin.distFile })),
  ]
    .map((artifact) => `[ -f "${IMAGE_ROOT}/${artifact.distFile}" ] || echo "${artifact.label}|${artifact.distFile}"`)
    .join('; ');
  let missing = '';
  try {
    missing = execFileSync(
      'docker',
      ['run', '--rm', '--entrypoint', 'sh', imageTag, '-c', probe],
      { encoding: 'utf8', timeout: 120_000 },
    ).trim();
  } catch (err) {
    failures.push(
      `could not probe image '${imageTag}': ${(err as Error).message} — ` +
        `build it first (docker build -f Dockerfile.oshal -t ${imageTag} .).`,
    );
  }
  for (const line of missing.split('\n').filter(Boolean)) {
    const [label, distFile] = line.split('|');
    failures.push(
      `${label}: ${distFile} MISSING from image '${imageTag}' - it was pruned from the build. ` +
        `An installed package importing this module fails at mount on this image.`,
    );
  }
  say(`kernel-skills: probed image ${imageTag}`);
}

// ── Phase 3: the package side (declaration ⊇ imports) ───────────────────────
// A store checkout is optional on this box, so the phase is conditional — but a gate that skips
// SILENTLY is not a gate, so the skip prints its reason even under --quiet.
let storeDir = storeFlag && storeFlag !== '.' ? path.resolve(storeFlag) : process.env.OSHAL_STORE_DIR || '';
if (!storeDir) {
  const sibling = path.resolve(REPO_ROOT, '..', 'oshal-applications');
  if (fs.existsSync(path.join(sibling, '.git'))) storeDir = sibling;
}
if (storeDir && fs.existsSync(storeDir)) {
  checkStorePackages(storeDir);
} else {
  shout(
    'kernel-skills: PHASE 3 SKIPPED — no store checkout found, so no package could be checked for ' +
      'undeclared kernel-skill imports. Point it at one with --store <path> or OSHAL_STORE_DIR=<path> ' +
      '(the conventional sibling ../oshal-applications is auto-detected). Phases 1-2 still ran.',
  );
}

// ── Verdict ─────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n✗ kernel-skill contract BROKEN (${failures.length}):\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error(
    `\nThe kernel's skills are its package-facing API (ADR-085 §2). A skill that leaves the ` +
      `image breaks installed apps at mount, not at compile time — that is why this is a gate.\n` +
      `Contract: docs/apps/kernel-skills.md\n`,
  );
  process.exit(1);
}

say('✓ kernel-skill contract holds — every declared skill is anchored and present.');
