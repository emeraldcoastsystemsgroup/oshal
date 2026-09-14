/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Seal bounded package source for isolated tests without mounting deployment files or credentials.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Include canonical packaged tool surfaces and TypeScript route sources in sealed test input.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Admit Node-harness Playwright recipes when the sandbox has verified the browser prerequisites; other kinds stay explicitly unavailable.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { PackageTestCase } from '@/shared/package-testing';
import { validateSandboxPath } from './package-test-sandbox-launcher';

export interface PackageTestSnapshot {
  files: Array<{ path: string; content: Buffer }>;
  revision: string;
  sourceCommit?: string;
}
const OMIT = new Set(['.git', 'node_modules', '__pycache__', '.cache', 'coverage', 'logs', 'output']);
const SOURCE_DIRS = new Set(['lib', 'src', 'src-routes', 'routes', 'ui', 'tools', 'scripts', 'migrations', 'tests', 'engine']);
const SOURCE_TYPES = /\.(?:[cm]?js|[cm]?ts|tsx|jsx|json|ya?ml|html|css|sql|py|txt|md|svg)$/i;
const ROOT_METADATA = new Set(['.oshal-install.json', 'oshal-app.yaml', 'authorization.yaml', 'tools.yaml', 'package.json', 'package-lock.json', 'tsconfig.json']);
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 4096;
/** @description What the closed Node profile satisfies without any probe: the only capabilities before the image is verified. */
export const NODE_RUNNER_CAPABILITIES: ReadonlySet<string> = new Set(['runner:node-test', 'fixture:core-checkout']);
/** @description Prerequisites the browser profile can satisfy, each admitted only once the sandbox probe has verified it on the image. */
export const BROWSER_RUNNER_PREREQUISITES: ReadonlySet<string> = new Set(['runner:playwright', 'browser:chromium',
  'core:shared-theme-assets', 'core:surface-bridge', 'core:dependencies', 'harness:oshal-core-root']);

/** @description Detect the Node test harness in a sealed suite; a browser recipe must be one, or it would run as a bare script. */
export function hasNodeTestHarness(content: Buffer): boolean {
  return /(?:\bfrom\s*['"]node:test['"]|\brequire\(\s*['"]node:test['"]\s*\))/.test(content.subarray(0, 65536).toString('utf8'));
}

/** @description Admit the closed offline Node recipe, or a Node-harness Playwright recipe once the browser profile is verified;
 * every other kind and every unverified prerequisite stays explicitly unavailable.
 * @param test Declared case. @param capabilities Prerequisites verified for the runner image. @returns Pending reason, or undefined when runnable. */
export function packageTestRecipePending(test: PackageTestCase, capabilities: ReadonlySet<string> = NODE_RUNNER_CAPABILITIES): string | undefined {
  const runner = test.runner;
  if ((runner.kind !== 'node-test' && runner.kind !== 'playwright') || runner.scope !== 'package') return `The ${runner.kind} runner is unavailable.`;
  const browser = runner.kind === 'playwright';
  if (browser && !(capabilities.has('runner:playwright') && capabilities.has('browser:chromium'))) return 'The playwright runner is unavailable.';
  if (runner.files.length > 64 || runner.files.some(file => !/\.[cm]?js$/.test(file))) return `The isolated ${browser ? 'browser' : 'Node'} recipe supports up to 64 JavaScript suite files.`;
  if (browser ? test.level !== 'browser' : !['unit', 'integration'].includes(test.level)) return 'Browser and live suites require their own verified runner.';
  if (!['none', 'fixture-write'].includes(test.sideEffects) || test.isolation.mode === 'live') return 'External effects are unavailable in the isolated test runner.';
  const known = new Set([...NODE_RUNNER_CAPABILITIES, ...capabilities]);
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
