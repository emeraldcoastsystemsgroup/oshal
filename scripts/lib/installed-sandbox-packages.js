/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Initial implementation: package staging for scripts/operations/installed-sandbox.js. A store package is named `name[@version]` and resolved at a store ref (default origin/main) of a local store clone through the installer's own catalog rules (resolveStorePackage from scripts/oshal-app.js); a private package is named by its directory inside the private repo and identified by the manifest it carries, so core never names one. The requested version must equal the manifest at that commit, required dependency apps must be staged too or ship in core swarm-apps (the installer's fail-closed rule), and the bytes come from `git archive` of the exact commit with core.autocrlf forced off - a Windows checkout otherwise emits CRLF and a CRLF shell script breaks under busybox sh. The archive is streamed into the sandbox's own workspace volume by a throwaway container from the same image with no network, and the `.oshal-install.json` provenance record (repo, ref, sha, audit posture, installedBy installed-sandbox) is written beside it the way the installer writes it.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { readAppDependencies } = require('../oshal-app-dependencies');

const PACKAGE_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Runs inside the throwaway staging container; the package name and record arrive by env name. */
const HELPER_SCRIPT = [
  'set -e',
  'mkdir -p /ws/deployed-apps',
  'tar -x -C /ws',
  'test -f "/ws/deployed-apps/$OSHAL_SANDBOX_PKG/oshal-app.yaml"',
  'printf "%s" "$OSHAL_SANDBOX_INSTALL_RECORD" > "/ws/deployed-apps/$OSHAL_SANDBOX_PKG/.oshal-install.json"',
  'echo "staged $OSHAL_SANDBOX_PKG"',
].join('; ');

/**
 * @description Parse a store package request `name` or `name@x.y.z`.
 * @param {string} text Command-line value. @returns {{name: string, version: string|null}} Request.
 */
function parsePackageSpec(text) {
  const value = String(text || '');
  const at = value.lastIndexOf('@');
  const name = at > 0 ? value.slice(0, at) : value;
  const version = at > 0 ? value.slice(at + 1) : null;
  if (!PACKAGE_NAME.test(name)) throw new Error(`invalid package name "${name}"`);
  if (version !== null && !VERSION.test(version)) throw new Error(`invalid version "${version}" for ${name}`);
  return { name, version };
}

/**
 * @description Parse a private package request `<dir>` or `<dir>@x.y.z` (the name comes from the
 * manifest, never from core).
 * @param {string} text Command-line value. @returns {{dir: string, version: string|null}} Request.
 */
function parsePrivateSpec(text) {
  const match = /^(.+?)(?:@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?))?$/.exec(String(text || ''));
  if (!match) throw new Error('a private package needs its directory');
  return { dir: match[1], version: match[2] || null };
}

/**
 * @description A git runner that never converts line endings and reports only the first stderr line.
 * @param {Function} spawnSync child_process.spawnSync (injected for tests).
 * @returns {(repo: string, args: string[]) => string} Runner returning trimmed stdout.
 */
function createGit(spawnSync) {
  return (repo, args) => {
    const result = spawnSync('git', ['-C', repo, '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const line = String(result.stderr || '').split('\n').find((item) => item.trim()) || `exit ${result.status}`;
      throw new Error(`git ${args[0]} failed: ${line.trim()}`);
    }
    return String(result.stdout).replace(/\s+$/, '');
  };
}

/** @description Resolve a ref to its commit. @param {Function} git Runner. @param {string} repo Repo dir. @param {string} ref Ref. @returns {string} Commit sha. */
function resolveCommit(git, repo, ref) {
  try {
    return git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    throw new Error(`ref "${ref}" does not name a commit in ${repo}`);
  }
}

/** @description Read a package manifest at a commit. @param {Function} git Runner. @param {string} repo Repo. @param {string} sha Commit. @param {string} dir Package dir. @returns {object} Manifest. */
function readManifestAt(git, repo, sha, dir) {
  const text = git(repo, ['show', `${sha}:${dir}/oshal-app.yaml`]);
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error(`${dir}/oshal-app.yaml exceeds ${MAX_MANIFEST_BYTES} bytes`);
  const manifest = yaml.load(text);
  if (!manifest || typeof manifest !== 'object') throw new Error(`${dir}/oshal-app.yaml is not a manifest`);
  return manifest;
}

/**
 * @description Resolve the catalog entry through the installer's own rules (one match, confined
 * git-subdir source, audit record path), by handing resolveStorePackage the catalog at that commit.
 * @param {string} catalogText marketplace.json at the commit. @param {string} name Requested name.
 * @returns {{name: string, sourcePath: string, auditRecord: string}} Entry.
 */
function resolveCatalogEntry(catalogText, name) {
  const { resolveStorePackage } = require('../oshal-app');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-sandbox-catalog-'));
  try {
    fs.writeFileSync(path.join(dir, 'marketplace.json'), catalogText);
    return resolveStorePackage(dir, name);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** @description Refuse a manifest whose identity differs from the request. @param {object} manifest Manifest. @param {string} name Expected name. @param {string|null} version Requested version. @returns {string} Manifest version. */
function checkIdentity(manifest, name, version) {
  if (manifest.name !== name) throw new Error(`manifest name "${manifest.name}" does not match "${name}"`);
  const actual = String(manifest.version ?? '');
  if (version !== null && actual !== version) throw new Error(`${name} is ${actual || 'unversioned'} at that ref, not the requested ${version}`);
  return actual;
}

/** @description The origin remote URL, or a file URL of the repo when it has none. @param {Function} git Runner. @param {string} repo Repo. @returns {string} Provenance repo. */
function provenanceRepo(git, repo) {
  try { return git(repo, ['remote', 'get-url', 'origin']); } catch { return `file://${path.resolve(repo).split(path.sep).join('/')}`; }
}

/** @description Audit status recorded for a catalog package at the commit. @param {Function} git Runner. @param {string} repo Repo. @param {string} sha Commit. @param {string} record Record path. @returns {string} Status. */
function auditStatusAt(git, repo, sha, record) {
  try { return String(JSON.parse(git(repo, ['show', `${sha}:${record}`])).status || 'unknown'); } catch { return 'unreadable'; }
}

/**
 * @description Stage one store package request at a store ref.
 * @param {Function} git Runner. @param {{storeDir: string, ref: string}} source Store clone and ref.
 * @param {{name: string, version: string|null}} spec Request.
 * @returns {object} Staged package descriptor.
 */
function stageStorePackage(git, source, spec) {
  const sha = resolveCommit(git, source.storeDir, source.ref);
  const entry = resolveCatalogEntry(git(source.storeDir, ['show', `${sha}:marketplace.json`]), spec.name);
  const manifest = readManifestAt(git, source.storeDir, sha, entry.sourcePath);
  const version = checkIdentity(manifest, entry.name, spec.version);
  return {
    kind: 'store', name: entry.name, version, sha, ref: source.ref, repoDir: source.storeDir, tree: `${sha}:${entry.sourcePath}`,
    repo: provenanceRepo(git, source.storeDir), auditRecord: entry.auditRecord,
    auditStatus: auditStatusAt(git, source.storeDir, sha, entry.auditRecord), dependencies: readAppDependencies(manifest),
  };
}

/**
 * @description Stage one private package by its directory inside the private repo.
 * @param {Function} git Runner. @param {{dir: string, version: string|null}} spec Request. @param {string} ref Ref.
 * @returns {object} Staged package descriptor.
 */
function stagePrivatePackage(git, spec, ref) {
  const dir = fs.realpathSync(spec.dir);
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  const rel = path.relative(fs.realpathSync(top), dir).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${spec.dir} is not a package directory inside its repository`);
  const sha = resolveCommit(git, top, ref);
  const manifest = readManifestAt(git, top, sha, rel);
  if (!PACKAGE_NAME.test(String(manifest.name))) throw new Error(`${rel}/oshal-app.yaml has an invalid name`);
  const version = checkIdentity(manifest, manifest.name, spec.version);
  return {
    kind: 'private', name: manifest.name, version, sha, ref, repoDir: top, tree: `${sha}:${rel}`,
    repo: provenanceRepo(git, top), auditRecord: null, auditStatus: 'not-cataloged', dependencies: readAppDependencies(manifest),
  };
}

/**
 * @description Resolve every staged package's dependency tiers the way the installer does: a
 * required app must be staged too or ship in core swarm-apps; an optional app is recorded as
 * installed or not-selected. A missing required app refuses the whole plan.
 * @param {object[]} staged Staged packages. @param {(name: string) => boolean} isCoreApp Core manifest test.
 * @returns {Map<string, object>} Package name -> { required, optional } resolution.
 */
function resolveStagedDependencies(staged, isCoreApp) {
  const names = new Set(staged.map((item) => item.name));
  const duplicates = staged.map((item) => item.name).filter((name, index, all) => all.indexOf(name) !== index);
  if (duplicates.length) throw new Error(`package staged twice: ${[...new Set(duplicates)].join(', ')}`);
  const out = new Map();
  for (const item of staged) {
    const resolution = { required: {}, optional: {} };
    for (const dep of item.dependencies.required.apps) {
      if (names.has(dep)) resolution.required[dep] = 'installed';
      else if (isCoreApp(dep)) resolution.required[dep] = 'core';
      else throw new Error(`${item.name} requires "${dep}", which is neither staged nor a core app (add --package ${dep})`);
    }
    for (const dep of item.dependencies.optional.apps) resolution.optional[dep] = names.has(dep) ? 'installed' : isCoreApp(dep) ? 'core' : 'not-selected';
    out.set(item.name, resolution);
  }
  return out;
}

/**
 * @description The `.oshal-install.json` the loader and the Test Lab read (repo is the provenance the
 * authorization source and the package test source are keyed on).
 * @param {object} item Staged package. @param {object} resolution Dependency resolution. @param {string} installedAt ISO time.
 * @returns {object} Install record.
 */
function buildInstallRecord(item, resolution, installedAt) {
  return {
    name: item.name, repo: item.repo, ref: item.ref, sha: item.sha, installedAt, dependencies: resolution,
    audit: {
      mode: 'compatible', status: item.auditStatus, verified: false, record: item.auditRecord, sourceSha: null,
      reasons: ['installed-sandbox staged this commit without an audit pin'],
    },
    installedBy: 'installed-sandbox',
  };
}

/** @description `git archive` arguments for one staged package (LF-exact, prefixed for the volume). @param {object} item Staged package. @returns {string[]} Arguments. */
function archiveArgs(item) {
  return ['-C', item.repoDir, '-c', 'core.autocrlf=false', 'archive', '--format=tar', `--prefix=deployed-apps/${item.name}/`, item.tree];
}

/**
 * @description `docker run` arguments for the throwaway staging container: same image, no network,
 * the sandbox project labels (so teardown's label sweep finds a straggler), the workspace volume.
 * @param {object} target { image, volume, project, labelKey }. @returns {string[]} Arguments.
 */
function helperArgs(target) {
  return [
    'run', '--rm', '-i', '--network', 'none', '--memory', '256m',
    '--label', `com.docker.compose.project=${target.project}`, '--label', `${target.labelKey}=${target.project}`,
    '-e', 'OSHAL_SANDBOX_PKG', '-e', 'OSHAL_SANDBOX_INSTALL_RECORD', '-v', `${target.volume}:/ws`,
    '--entrypoint', 'sh', target.image, '-c', HELPER_SCRIPT,
  ];
}

/**
 * @description Stream one package from git into the sandbox workspace volume and write its record.
 * @param {object} deps { spawn, env }. @param {object} item Staged package. @param {object} record Install record.
 * @param {object} target { image, volume, project, labelKey }.
 * @returns {Promise<void>} Resolves when both processes exit 0.
 */
function streamPackageIntoVolume(deps, item, record, target) {
  return new Promise((resolve, reject) => {
    const archive = deps.spawn('git', archiveArgs(item), { stdio: ['ignore', 'pipe', 'pipe'] });
    const helper = deps.spawn('docker', helperArgs(target), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...deps.env, OSHAL_SANDBOX_PKG: item.name, OSHAL_SANDBOX_INSTALL_RECORD: JSON.stringify(record, null, 2) },
    });
    const errors = [];
    archive.stderr.on('data', (chunk) => errors.push(`git: ${String(chunk).trim()}`));
    helper.stderr.on('data', (chunk) => errors.push(`docker: ${String(chunk).trim()}`));
    archive.stdout.pipe(helper.stdin);
    let pending = 2;
    const done = (who) => (code) => {
      if (code !== 0) errors.push(`${who} exited ${code}`);
      pending -= 1;
      if (pending === 0) (errors.some((line) => / exited /.test(line)) ? reject(new Error(`staging ${item.name} failed: ${errors.join(' | ')}`)) : resolve());
    };
    archive.on('close', done('git archive'));
    helper.on('close', done('staging container'));
  });
}

module.exports = {
  PACKAGE_NAME, HELPER_SCRIPT, parsePackageSpec, parsePrivateSpec, createGit, resolveCommit, stageStorePackage, stagePrivatePackage,
  resolveStagedDependencies, buildInstallRecord, archiveArgs, helperArgs, streamPackageIntoVolume,
};
