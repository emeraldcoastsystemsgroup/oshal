#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | trackedFiles() falls back to a filesystem walk when the target is not a git repo: ci-local --head runs this gate against a `git archive` EXPORT of HEAD (no .git), where the first --head run crashed 'fatal: not a git repository' — in an export, disk contents ARE HEAD's tracked files, so the walk judges the identical tree.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | resolveCoreDir() catches the SECOND git dependence the 07-23 fix missed: with no --core flag the script still ran an unconditional `git rev-parse --show-toplevel`, which crashed 'fatal: not a git repository' in the .git-less GATE_SRC export — redding BOTH the ci-local repo-separation gate and the unit spec on a healthy tree. In an export the process is launched at the tree root, so cwd IS the tree (same rationale as trackedFiles).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Structural guard for the two-trunk split (ADR-115): application code must never mix into the swarm/kernel repo, and kernel code must never mix into the store repo. ADR-085 carved 21 app surfaces OUT of core; nothing stopped one from walking back in. The public core trunk is a DERIVED, app-free artifact — a re-mixed app is a release-blocking defect discovered at publish time, which is far too late.
 */

/**
 * @description Assert the swarm (kernel) repo and the application (store) repo stay separate.
 *
 * ADR-085 physically carved every application surface out of the kernel; ADR-115 makes the clean,
 * no-history repo the trunk. Both depend on one invariant:
 *
 *     the kernel repo ships PLATFORM code; applications live in the store repo.
 *
 * That line is only real if something enforces it. The sharpest marker is `oshal-app.yaml` — the
 * store package manifest. Exactly one of those in the kernel tree means an application has been
 * re-mixed into the platform, and the app-free public core snapshot is no longer app-free.
 *
 * CORE checks (always run):
 *   1. No tracked `oshal-app.yaml` anywhere — that file IS an application package.
 *   2. `swarm-apps/*.yaml` is exactly the kernel-resident allowlist. A new manifest here is a new
 *      application in the platform repo; it belongs in the store.
 *   3. No tracked files under `apps/` or `deployed-apps/` (installed-package staging dirs).
 *   4. No tracked `.oshal-install.json` (package install provenance — a runtime artifact).
 *
 * STORE checks (run when a store checkout is given/found):
 *   5. No kernel-shaped paths (server entrypoint, the image, the compose stack, kernel skills).
 *
 * Usage:
 *   node scripts/check-repo-separation.js                 # core only
 *   node scripts/check-repo-separation.js --store <dir>   # core + that store checkout
 *   node scripts/check-repo-separation.js --core <dir>    # check a different checkout (tests)
 *
 * Exit 0 = the split holds. Exit 1 = code is in the wrong repo.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * The kernel-RESIDENT manifests — the ten core-platform applications that must NOT carve
 * (ADR-085 completion, 2026-07-19). Adding a name here is an architectural decision, not a
 * convenience: it declares the app is platform, permanently, and will ship in the public core.
 */
const KERNEL_MANIFESTS = [
  'codex-packer.yaml',
  'devops.yaml',
  'intelligent-operations.yaml',
  'intelligent-processing.yaml',
  'jarvis.yaml',
  'oshal-dev.yaml',
  'oshal-engineering.yaml',
  'person-model.yaml',
  'security.yaml',
  'workflow-studio.yaml',
];

/**
 * Explicit-load manifest variant dirs that are kernel-resident by design: `swarm-apps-build/`
 * (the build pipeline's own manifest). Listed so the check is an allowlist, not a glob that
 * silently accepts a new directory.
 */
const KERNEL_VARIANT_MANIFESTS = {
  'swarm-apps-build': ['oshal-engineering.yaml'],
};

/** Kernel paths that prove a store checkout has absorbed platform code. */
const KERNEL_SHAPED_PATHS = [
  'src/app/server.ts',
  'src/app/bot-node-server.ts',
  'src/shared/kernel-skills',
  'Dockerfile.oshal',
  'docker-compose.oshal-local.yml',
];

const problems = [];
const passes = [];

/**
 * @description List every tracked file in a git checkout — or, when the directory is not a git
 * repository (the ci-local --head GATE_SRC is a `git archive` EXPORT of committed HEAD, no .git),
 * every file on disk. In an export the two are equivalent by construction: the archive contains
 * exactly HEAD's tracked files, so a filesystem walk judges the same tree `git ls-files` would.
 * Without this fallback the gate crashed ("fatal: not a git repository") the first time it ran in
 * --head mode, 2026-07-23 — a red that said nothing about repo separation.
 * @param {string} repoDir - Repository root (a checkout or an exported tree).
 * @returns {string[]} Repo-relative paths (forward slashes).
 */
function trackedFiles(repoDir) {
  if (fs.existsSync(path.join(repoDir, '.git'))) {
    const out = execFileSync('git', ['-C', repoDir, 'ls-files'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').filter(Boolean);
  }
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // node_modules can only appear in an export if it were tracked — it never is; skipping keeps
      // the walk fast when the gate links deps into GATE_SRC for the typecheck/unit gates.
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else files.push(relPath);
    }
  };
  walk(repoDir, '');
  return files;
}

/**
 * @description Record a failed check with the offending paths.
 * @param {string} title - What broke.
 * @param {string[]} offenders - Paths to show (capped).
 * @param {string} fix - The remedy, stated concretely.
 * @returns {void}
 */
function fail(title, offenders, fix) {
  problems.push({ title, offenders: offenders.slice(0, 20), fix });
}

/**
 * @description Run the kernel-repo half of the split check.
 * @param {string} coreDir - Kernel repository root.
 * @returns {void}
 */
function checkCore(coreDir) {
  const files = trackedFiles(coreDir);

  // 1. An application package manifest in the platform repo. This is the whole rule in one line.
  const packages = files.filter((f) => path.basename(f) === 'oshal-app.yaml');
  if (packages.length) {
    fail(
      'application package(s) tracked in the swarm repo',
      packages,
      'An `oshal-app.yaml` IS a store package. Move the package to the oshal-applications repo and ' +
        'install it with `node scripts/oshal-app.js install <name>` — do not carry it in the kernel.',
    );
  } else {
    passes.push('no application packages tracked in the kernel');
  }

  // 2. swarm-apps/ is the kernel manifest set, exactly.
  const manifestDir = path.join(coreDir, 'swarm-apps');
  const present = fs.existsSync(manifestDir)
    ? fs.readdirSync(manifestDir).filter((f) => /\.ya?ml$/.test(f)).sort()
    : [];
  const unexpected = present.filter((f) => !KERNEL_MANIFESTS.includes(f));
  const missing = KERNEL_MANIFESTS.filter((f) => !present.includes(f));
  if (unexpected.length) {
    fail(
      'non-kernel manifest(s) in swarm-apps/',
      unexpected.map((f) => `swarm-apps/${f}`),
      'A new manifest here is a new application inside the platform repo. Ship it as a store ' +
        'package instead. If it genuinely is core platform, add it to KERNEL_MANIFESTS in this ' +
        'script with the reasoning in an ADR — that is a deliberate, reviewed decision.',
    );
  } else if (missing.length) {
    fail(
      'kernel manifest(s) missing from swarm-apps/',
      missing.map((f) => `swarm-apps/${f}`),
      'These ten are the core-platform applications that must not carve (ADR-085). If one was ' +
        'carved on purpose, remove it from KERNEL_MANIFESTS in this script and say why in the ADR.',
    );
  } else {
    passes.push(`swarm-apps/ holds exactly the ${KERNEL_MANIFESTS.length} kernel manifests`);
  }

  // 2b. The explicit-load variant dirs, same allowlist treatment.
  for (const [dir, allowed] of Object.entries(KERNEL_VARIANT_MANIFESTS)) {
    const full = path.join(coreDir, dir);
    if (!fs.existsSync(full)) continue;
    const found = fs.readdirSync(full).filter((f) => /\.ya?ml$/.test(f));
    const extra = found.filter((f) => !allowed.includes(f));
    if (extra.length) {
      fail(
        `unexpected manifest(s) in ${dir}/`,
        extra.map((f) => `${dir}/${f}`),
        `${dir}/ is a kernel-resident variant directory with a fixed membership. A new ticket-type ` +
          'manifest belongs in a store package.',
      );
    }
  }

  // 3. Installed-package staging directories must never be tracked.
  const staged = files.filter((f) => /^(apps|deployed-apps)\//.test(f));
  if (staged.length) {
    fail(
      'installed-application directories are tracked',
      staged,
      '`apps/` and `deployed-apps/` are runtime staging for installed packages (they live in the ' +
        'oshal_workspace volume). They must stay untracked — add them to .gitignore.',
    );
  } else {
    passes.push('no installed-application directories tracked');
  }

  // 4. Package install provenance is a runtime artifact, never source.
  const provenance = files.filter((f) => path.basename(f) === '.oshal-install.json');
  if (provenance.length) {
    fail(
      'package install provenance tracked in the kernel',
      provenance,
      '`.oshal-install.json` is written by `oshal-app install` at runtime. Untrack it.',
    );
  }
}

/**
 * @description Run the store-repo half of the split check.
 * @param {string} storeDir - Application store repository root.
 * @returns {void}
 */
function checkStore(storeDir) {
  const files = new Set(trackedFiles(storeDir));
  const absorbed = KERNEL_SHAPED_PATHS.filter(
    (p) => files.has(p) || [...files].some((f) => f.startsWith(`${p}/`)),
  );
  if (absorbed.length) {
    fail(
      'kernel/platform code tracked in the store repo',
      absorbed,
      'The store repo holds application packages only. Platform code belongs in the kernel repo; ' +
        'a package reaches kernel capability through `uses:` (kernel skills), never by copying it.',
    );
  } else {
    passes.push(`store checkout holds no kernel-shaped paths (${storeDir})`);
  }

  const packages = [...files].filter((f) => path.basename(f) === 'oshal-app.yaml');
  passes.push(`store checkout declares ${packages.length} application package(s)`);
}

/**
 * @description Resolve the kernel checkout to judge when no `--core` flag is given. A normal
 * checkout resolves via `git rev-parse --show-toplevel`; the ci-local --head GATE_SRC is a
 * `git archive` EXPORT of committed HEAD with NO .git, where rev-parse dies "fatal: not a git
 * repository" — a crash that reds the gate while saying nothing about repo separation (the
 * 2026-07-23 fix caught this for trackedFiles() but missed this call). In an export the gate
 * launches the script from the tree root, so cwd IS the tree — the same equivalence trackedFiles
 * documents for its filesystem-walk fallback.
 * @returns {string} Kernel repository root to check.
 */
function resolveCoreDir() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return process.cwd();
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const storeFlag = args.indexOf('--store');
const coreFlag = args.indexOf('--core');
// `--core` exists so the guard's own regression spec can point it at a fixture checkout and prove
// it goes RED. A guard nobody has watched fail is a guard nobody knows works.
const coreDir = coreFlag >= 0 ? path.resolve(args[coreFlag + 1]) : resolveCoreDir();

checkCore(coreDir);

let storeDir = storeFlag >= 0 ? args[storeFlag + 1] : process.env.OSHAL_STORE_DIR || '';
// Autodetect the conventional sibling checkout, but never when --core points somewhere else: a
// fixture run must scan the fixture, not this box's real store.
if (!storeDir && coreFlag < 0) {
  // Absent is normal (CI, a fresh clone) — the CORE half above is the hard gate and always runs;
  // the store half is a bonus when the checkout is on this box.
  const sibling = path.resolve(coreDir, '..', 'oshal-applications');
  if (fs.existsSync(path.join(sibling, '.git'))) storeDir = sibling;
}
if (storeDir && fs.existsSync(path.join(storeDir, '.git'))) {
  checkStore(path.resolve(storeDir));
} else {
  passes.push('no store checkout present — core-side checks only');
}

for (const p of passes) console.log(`  ✓ ${p}`);

if (problems.length) {
  console.error('\n✖ REPO SEPARATION VIOLATED (ADR-115)\n');
  for (const { title, offenders, fix } of problems) {
    console.error(`  ${title}:`);
    for (const o of offenders) console.error(`      ${o}`);
    console.error(`    fix: ${fix}\n`);
  }
  console.error('  The swarm repo ships the platform. Applications ship from the store repo.');
  console.error('  Mixing them re-couples what ADR-085 spent 21 carves separating.\n');
  process.exit(1);
}

console.log('\nRepo separation holds: platform code and application code are in their own repos.');
process.exit(0);
