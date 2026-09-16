/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Seal bounded package source for isolated tests without mounting deployment files or credentials.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Include canonical packaged tool surfaces and TypeScript route sources in sealed test input.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Admit Node-harness Playwright recipes when the sandbox has verified the browser prerequisites; other kinds stay explicitly unavailable.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Replace the hardcoded pair of admitted kinds with a sealed-profile runner table (capability, container profile, levels, harness per kind) and name, as the operator-visible pending reason, which kinds are deliberately out of scope and which boundary admitting them would move.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Stage a package's catalog/ directory. Packages ship data their routes read at runtime there (animatronics' servos.json, circuit-lab's drivers.json); without it the sealed sandbox ran a snapshot that differed from the installed package, and the route and browser suites of both failed on ENOENT in the Test Lab while passing on a host checkout. The allowlist stays an allowlist: runtime data, credentials and every other directory are still excluded.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Stage a package's personas/ directory too. A package suite that loads its manifest through the framework's own loader reads the persona files the manifest names; without them animatronics' routes-http failed one case in the Test Lab (ENOENT personas/animatronics-director.yaml) while passing on a host checkout. Persona YAML is shipped, reviewed package source - 41 of the 59 store packages carry the directory.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Admit harness:core-test-fixtures as a probe-verified browser prerequisite. Three store browser cases (cad-studio, embodied, scan-to-print) declare it because they require the core's shared browser fixtures from OSHAL_CORE_ROOT; the image now carries that closure and the probe loads it, so the name is something the image can prove rather than a permanent pending reason.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { PackageTestCase, PackageTestLevel } from '@/shared/package-testing';
import { validateSandboxPath, type PackageTestSandboxProfile } from './package-test-sandbox-launcher';

export interface PackageTestSnapshot {
  files: Array<{ path: string; content: Buffer }>;
  revision: string;
  sourceCommit?: string;
}
const OMIT = new Set(['.git', 'node_modules', '__pycache__', '.cache', 'coverage', 'logs', 'output']);
const SOURCE_DIRS = new Set(['lib', 'src', 'src-routes', 'routes', 'ui', 'tools', 'scripts', 'migrations', 'tests', 'engine', 'catalog', 'personas']);
const SOURCE_TYPES = /\.(?:[cm]?js|[cm]?ts|tsx|jsx|json|ya?ml|html|css|sql|py|txt|md|svg)$/i;
const ROOT_METADATA = new Set(['.oshal-install.json', 'oshal-app.yaml', 'authorization.yaml', 'tools.yaml', 'package.json', 'package-lock.json', 'tsconfig.json']);
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 4096;
/** @description What the closed Node profile satisfies without any probe: the only capabilities before the image is verified. */
export const NODE_RUNNER_CAPABILITIES: ReadonlySet<string> = new Set(['runner:node-test', 'fixture:core-checkout']);
/** @description Prerequisites the browser profile can satisfy, each admitted only once the sandbox probe has verified it on the image.
 * `harness:core-test-fixtures` is the core's shared browser fixtures (CORE_TEST_FIXTURES) loading through tsx from the core root. */
export const BROWSER_RUNNER_PREREQUISITES: ReadonlySet<string> = new Set(['runner:playwright', 'browser:chromium',
  'core:shared-theme-assets', 'core:surface-bridge', 'core:dependencies', 'harness:oshal-core-root', 'harness:core-test-fixtures']);
/** @description Every prerequisite a probe may verify on the runner image. Membership here is permission to ASK the image,
 * never an assumption about it: an unverified name keeps its runner kind explicitly unavailable. */
export const PROBE_VERIFIED_PREREQUISITES: ReadonlySet<string> = new Set([...BROWSER_RUNNER_PREREQUISITES, 'runner:vitest']);

const NODE_TEST_HARNESS = /(?:\bfrom\s*['"]node:test['"]|\brequire\(\s*['"]node:test['"]\s*\))/;
const VITEST_HARNESS = /(?:\bfrom\s*['"]vitest['"]|\brequire\(\s*['"]vitest['"]\s*\))/;

/** @description One runner kind the sealed profile can actually execute. */
export interface RunnerProfileRecipe {
  /** Container profile the launcher runs this kind under; the catalog never lets a package choose it. */
  profile: PackageTestSandboxProfile;
  /** Probe-verified prerequisites the image must satisfy before the kind is admitted at all. */
  capabilities: readonly string[];
  /** Evidence levels a case of this kind may claim. */
  levels: readonly PackageTestLevel[];
  /** Harness every suite file must carry, or it would run as a bare script and report nothing. */
  harness?: { pattern: RegExp; reason: string };
}

/**
 * @description The sealed-profile runner recipes, one row per runner kind. Adding a kind means adding a
 * capability its probe can verify and a container profile that satisfies it — not relaxing the boundary:
 * a kind here still runs with no network, no mounts and no daemon socket.
 */
export const RUNNER_PROFILES: Readonly<Record<string, RunnerProfileRecipe>> = {
  'node-test': { profile: 'node', capabilities: ['runner:node-test'], levels: ['unit', 'integration'] },
  playwright: { profile: 'browser', capabilities: ['runner:playwright', 'browser:chromium'], levels: ['browser'],
    harness: { pattern: NODE_TEST_HARNESS, reason: 'Browser recipe requires the Node test harness (node:test).' } },
  vitest: { profile: 'vitest', capabilities: ['runner:vitest'], levels: ['unit', 'integration'],
    harness: { pattern: VITEST_HARNESS, reason: 'Vitest recipe requires an explicit vitest import; the sealed profile supplies no config, so vitest globals are unavailable.' } },
};

/**
 * @description Runner kinds deliberately left out of the sealed profile, with the reason an operator sees as the
 * catalog's pending reason. These are boundary decisions, not unfinished work: admitting them would mean handing
 * package code a network, a host mount or the Docker socket, which the sealed profile exists to withhold.
 */
export const RUNNER_OUT_OF_SCOPE: Readonly<Record<string, string>> = {
  external: 'The external runner is unavailable. It drives a service outside the container — its own database or host fixture — and the sealed profile has no network, no mounts and no daemon socket.',
  smoke: 'The smoke runner is unavailable. Installation smokes run through the smoke verifier, not the isolated runner.',
};
/** @description Why a core-scoped recipe can never run here: a package snapshot stages package bytes only. */
export const CORE_SCOPE_UNAVAILABLE = 'A core-scoped recipe is unavailable. Only package-staged suite files run in the sealed profile.';

/** @description Detect the Node test harness in a sealed suite; a browser recipe must be one, or it would run as a bare script. */
export function hasNodeTestHarness(content: Buffer): boolean {
  return NODE_TEST_HARNESS.test(content.subarray(0, 65536).toString('utf8'));
}

/** @description Report the harness a sealed suite file is missing for its runner kind, so a suite that would
 * execute as a bare script and report nothing is refused at sealing instead of published as a pass.
 * @param kind Declared runner kind. @param content Sealed suite bytes. @returns Refusal reason, or undefined. */
export function runnerHarnessFailure(kind: string, content: Buffer): string | undefined {
  const harness = RUNNER_PROFILES[kind]?.harness;
  if (!harness || harness.pattern.test(content.subarray(0, 65536).toString('utf8'))) return undefined;
  return harness.reason;
}

/** @description Admit a declared recipe against the sealed-profile table: the kind must have a profile, its
 * capabilities must be probe-verified on the image, and its level, effects and prerequisites must fit.
 * Every other kind stays explicitly unavailable with the reason it is out of scope.
 * @param test Declared case. @param capabilities Prerequisites verified for the runner image. @returns Pending reason, or undefined when runnable. */
export function packageTestRecipePending(test: PackageTestCase, capabilities: ReadonlySet<string> = NODE_RUNNER_CAPABILITIES): string | undefined {
  const runner = test.runner;
  const recipe = runner.kind === 'smoke' ? undefined : RUNNER_PROFILES[runner.kind];
  if (runner.kind === 'smoke' || !recipe) return RUNNER_OUT_OF_SCOPE[runner.kind] ?? `The ${runner.kind} runner is unavailable.`;
  if (runner.scope !== 'package') return CORE_SCOPE_UNAVAILABLE;
  const known = new Set([...NODE_RUNNER_CAPABILITIES, ...capabilities]);
  if (recipe.capabilities.some(name => !known.has(name))) return `The ${runner.kind} runner is unavailable.`;
  if (runner.files.length > 64 || runner.files.some(file => !/\.[cm]?js$/.test(file))) {
    return `The isolated ${runner.kind === 'playwright' ? 'browser' : runner.kind === 'vitest' ? 'vitest' : 'Node'} recipe supports up to 64 JavaScript suite files.`;
  }
  if (!recipe.levels.includes(test.level)) return 'Browser and live suites require their own verified runner.';
  if (!['none', 'fixture-write'].includes(test.sideEffects) || test.isolation.mode === 'live') return 'External effects are unavailable in the isolated test runner.';
  const missing = test.prerequisites.filter(value => !known.has(value));
  if (missing.length) return `Additional prerequisites require verification: ${missing.join(', ')}.`;
  return undefined;
}

/** @description Read one regular, single-link file and refuse replacement or parent-link races. */
function readFile(root: string, name: string): Buffer {
  const full = path.join(root, name), before = lstatSync(full);
  if (!before.isFile() || before.nlink !== 1 || before.size > 4 * 1024 * 1024 || realpathSync(full) !== full) throw new Error('Package source must contain bounded regular files.');
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw new Error('Package source changed while reading.');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0, count = 0;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    const after = fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.nlink !== 1 || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || realpathSync(full) !== full) throw new Error('Package source changed while reading.');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

/** @description Exclude installation secrets, caches and dependencies from package-supplied test input. */
function excluded(name: string): boolean {
  return OMIT.has(name) || name.startsWith('.') && name !== '.oshal-install.json'
    || ['data', 'workspace', 'workspace-shared', 'out', 'storage', 'uploads', 'backups'].includes(name)
    || /^(?:secrets?|credentials?|tokens?)(?:[.-]|$)/i.test(name) || /\.(?:pem|key|pfx|p12)$/i.test(name);
}

/** @description Traverse without following links, enforcing total input and entry bounds. */
function walk(root: string, relative: string, files: PackageTestSnapshot['files'], size: { bytes: number; entries: number }): void {
  const directory = path.join(root, relative);
  if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) throw new Error('Package directory links are unavailable.');
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (++size.entries > MAX_FILES) throw new Error('Package source exceeds the isolated runner entry limit.');
    if (excluded(entry.name)) continue;
    if (!relative && entry.isDirectory() && !SOURCE_DIRS.has(entry.name)) continue;
    if (!relative && !entry.isDirectory() && !ROOT_METADATA.has(entry.name) && !/\.[cm]?[jt]s$/.test(entry.name)) continue;
    if (!entry.isDirectory() && !SOURCE_TYPES.test(entry.name)) continue;
    if (/[\\/:\x00-\x1f]/.test(entry.name)) throw new Error('Package source contains an unsupported file name.');
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    validateSandboxPath(name);
    if (entry.isSymbolicLink()) throw new Error('Package source links are unavailable.');
    if (entry.isDirectory()) walk(root, name, files, size);
    else {
      const content = readFile(root, name); size.bytes += content.length;
      if (size.bytes > MAX_BYTES) throw new Error('Package source exceeds the isolated runner byte limit.');
      files.push({ path: name, content });
    }
  }
}

/** @description Snapshot all executable inputs and installer provenance without executing package code. */
export function snapshotPackageTests(packageDir: string): PackageTestSnapshot {
  const root = realpathSync(packageDir), files: PackageTestSnapshot['files'] = [];
  walk(root, '', files, { bytes: 0, entries: 0 });
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const hash = createHash('sha256');
  for (const file of files) hash.update(JSON.stringify([file.path, createHash('sha256').update(file.content).digest('hex')]));
  const provenance = files.find(file => file.path === '.oshal-install.json');
  const stamp = provenance ? JSON.parse(provenance.content.toString('utf8')) as { sha?: string } : undefined;
  return { files: files.filter(file => file.path !== '.oshal-install.json'), revision: hash.digest('hex'),
    ...(stamp?.sha && /^[a-f0-9]{40}$/.test(stamp.sha) ? { sourceCommit: stamp.sha } : {}) };
}
