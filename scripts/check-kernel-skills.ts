/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085/ADR-090 D8: the kernel-skills CI guard. Asserts every skill the kernel PROMISES packages (@/shared/kernel-skills) is actually re-exported by the build anchor and actually present in the built image. This is the guard that turns the google-calendar/notifications silent-prune class of bug into a red CI run instead of a mount-time failure inside a customer's installed app.
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
 * Usage:
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/check-kernel-skills.ts
 *   … --dist .            # also assert ./dist/** after a local server build
 *   … --image oshal-ci:latest   # also assert /app/dist/** inside the image
 *
 * Exit 0 = contract holds. Exit 1 = a package that imports the named skill would fail at mount.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { KERNEL_SKILLS, type KernelSkillModule } from '@/shared/kernel-skills';

const REPO_ROOT = path.resolve(__dirname, '..');
const ANCHOR_REL = 'src/app/composition/kernel-skills.ts';
/** Where the image's build root lives — the Dockerfile's WORKDIR. */
const IMAGE_ROOT = '/app';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const distRoot = readFlag('--dist');
const imageTag = readFlag('--image');

const failures: string[] = [];

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
  say(`kernel-skills: checked build root ${root}`);
}

if (imageTag) {
  // One exec, one shell: print every distFile that is NOT present inside the image.
  const probe = allModules
    .map((m) => `[ -f "${IMAGE_ROOT}/${m.distFile}" ] || echo "${m.skill}|${m.distFile}"`)
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
    const [skill, distFile] = line.split('|');
    failures.push(
      `skill '${skill}': ${distFile} MISSING from image '${imageTag}' — it was pruned from the ` +
        `build. Any installed package importing this skill fails at mount on this image.`,
    );
  }
  say(`kernel-skills: probed image ${imageTag}`);
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
