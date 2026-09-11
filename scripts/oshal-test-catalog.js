/** TLAB-01: one closed, bounded package test-catalog validator for the CLI and runtime. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const yaml = require('js-yaml');
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
function fail(app, field, message) { throw new Error(`Application ${app || '(unnamed)'} testing.${field}: ${message}`); }
function exact(value, keys, app, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(app, field, 'must be a mapping');
  const unknown = Object.keys(value).filter(key => !keys.includes(key));
  if (unknown.length) fail(app, field, `unknown fields: ${unknown.join(', ')}`);
}
function text(value, app, field, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(app, field, `must be non-empty text of at most ${max} characters`);
}
function id(value, app, field) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
    || ['constructor', 'prototype', '__proto__'].includes(value)) fail(app, field, 'must be a stable lower-case ID (1-64 characters)');
}
function choice(value, values, app, field) { if (!values.includes(value)) fail(app, field, `must be one of ${values.join(', ')}`); }
function list(value, app, field, max = 128, empty = false) {
  if (!Array.isArray(value) || value.length > max || (!empty && !value.length)) fail(app, field, `must contain ${empty ? '0' : '1'}-${max} items`);
  if (new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail(app, field, 'contains duplicates');
}
function relativeFile(value, app, field) {
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9_@./-]+$/.test(value)
    || value.startsWith('/') || value.split('/').some(segment => !segment || segment === '.' || segment === '..')) fail(app, field, 'must be a canonical relative file path');
}
function confinedFile(root, value, app, field, max = MAX_FILE_BYTES) {
  relativeFile(value, app, field);
  let target = root;
  try {
    for (const segment of value.split('/')) {
      target = path.join(target, segment);
      if (fs.lstatSync(target).isSymbolicLink()) fail(app, field, 'symlinks are not permitted');
    }
    const resolved = fs.realpathSync(target), rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) fail(app, field, 'escapes the package');
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > max) fail(app, field, `must be a file of at most ${max} bytes`);
    return fs.readFileSync(resolved);
  } catch (error) {
    if (String(error.message).startsWith('Application ')) throw error;
    fail(app, field, `file unavailable: ${value}`);
  }
}
/** Shape validation is pure; file loading and content fingerprints are performed below. */
function validatePackageTestCatalog(value, manifest) {
  const app = manifest.name;
  exact(value, ['version', 'cases'], app, 'catalog');
  if (value.version !== 1) fail(app, 'catalog.version', 'unsupported schema version');
  list(value.cases, app, 'cases', 256);
  const ids = new Set(), smokeNames = new Set();
  const smokes = Array.isArray(manifest.smoke) ? manifest.smoke : [];
  for (const [index, test] of value.cases.entries()) {
    const at = `cases[${index}]`;
    exact(test, ['id', 'name', 'purpose', 'level', 'runner', 'expected', 'prerequisites', 'sideEffects', 'isolation', 'limits', 'installation'], app, at);
    id(test.id, app, `${at}.id`); if (ids.has(test.id)) fail(app, `${at}.id`, `duplicate case ID ${test.id}`); ids.add(test.id);
    text(test.name, app, `${at}.name`, 200); text(test.purpose, app, `${at}.purpose`);
    choice(test.level, ['unit', 'integration', 'browser', 'live'], app, `${at}.level`);
    list(test.expected, app, `${at}.expected`, 32); test.expected.forEach((item, i) => text(item, app, `${at}.expected[${i}]`, 500));
    list(test.prerequisites, app, `${at}.prerequisites`, 32, true);
    test.prerequisites.forEach(item => { if (typeof item !== 'string' || !/^[a-z][a-z0-9:._-]{0,127}$/.test(item)) fail(app, `${at}.prerequisites`, 'must contain stable prerequisite IDs'); });
    choice(test.sideEffects, ['none', 'fixture-write', 'external-write', 'device-action'], app, `${at}.sideEffects`);
    exact(test.isolation, ['mode', 'fixtures', 'cleanup'], app, `${at}.isolation`);
    choice(test.isolation.mode, ['none', 'disposable', 'live'], app, `${at}.isolation.mode`);
    if (test.isolation.fixtures !== undefined) {
      list(test.isolation.fixtures, app, `${at}.isolation.fixtures`, 32);
      test.isolation.fixtures.forEach(file => relativeFile(file, app, `${at}.isolation.fixtures`));
    }
    if (test.isolation.cleanup !== undefined) text(test.isolation.cleanup, app, `${at}.isolation.cleanup`);
    if (test.sideEffects === 'fixture-write' && (test.isolation.mode !== 'disposable' || !test.isolation.cleanup)) fail(app, `${at}.isolation`, 'fixture writes require disposable isolation and a cleanup description');
    if (['external-write', 'device-action'].includes(test.sideEffects) && test.isolation.mode !== 'live') fail(app, `${at}.isolation`, 'external side effects require explicit live isolation');
    exact(test.limits, ['timeoutMs', 'maxMemoryMb'], app, `${at}.limits`);
    if (!Number.isInteger(test.limits.timeoutMs) || test.limits.timeoutMs < 100 || test.limits.timeoutMs > 300000) fail(app, `${at}.limits.timeoutMs`, 'must be 100-300000');
    if (test.limits.maxMemoryMb !== undefined && (!Number.isInteger(test.limits.maxMemoryMb) || test.limits.maxMemoryMb < 16 || test.limits.maxMemoryMb > 4096)) fail(app, `${at}.limits.maxMemoryMb`, 'must be 16-4096');
    choice(test.installation, ['never', 'safe-smoke'], app, `${at}.installation`);
    const runner = test.runner;
    if (runner?.kind === 'smoke') {
      exact(runner, ['kind', 'smoke'], app, `${at}.runner`); id(runner.smoke, app, `${at}.runner.smoke`);
      const smoke = smokes.find(item => item.name === runner.smoke);
      if (!smoke) fail(app, `${at}.runner.smoke`, `unknown smoke ${runner.smoke}`);
      if (test.id !== runner.smoke || smokeNames.has(runner.smoke)) fail(app, `${at}.id`, 'a smoke reference must use its original smoke ID exactly once');
      smokeNames.add(runner.smoke);
      if (test.level !== 'integration') fail(app, `${at}.level`, 'existing smoke references are integration checks');
      if (test.installation === 'safe-smoke' && (!['GET', 'HEAD'].includes(smoke.method) || smoke.requiresAi || test.sideEffects !== 'none' || test.prerequisites.length)) fail(app, `${at}.installation`, 'only non-AI GET/HEAD smokes without extra prerequisites or side effects are installation eligible');
    } else {
      exact(runner, ['kind', 'scope', 'files', 'revision'], app, `${at}.runner`);
      choice(runner.kind, ['vitest', 'node-test', 'playwright', 'external'], app, `${at}.runner.kind`);
      choice(runner.scope, ['package', 'core'], app, `${at}.runner.scope`);
      list(runner.files, app, `${at}.runner.files`, 64); runner.files.forEach(file => relativeFile(file, app, `${at}.runner.files`));
      if (smokes.some(smoke => smoke.name === test.id)) fail(app, `${at}.id`, 'collides with an existing smoke ID');
      if (runner.scope === 'core') {
        if (typeof runner.revision !== 'string' || !/^[a-f0-9]{40}$/.test(runner.revision)) fail(app, `${at}.runner.revision`, 'core references require an exact 40-character commit');
        if (runner.files.some(file => !file.startsWith('tests/'))) fail(app, `${at}.runner.files`, 'core suite references must be under tests/');
      } else if (runner.revision !== undefined) fail(app, `${at}.runner.revision`, 'package references use the installed content revision');
      if (test.installation !== 'never') fail(app, `${at}.installation`, 'local/core suites cannot execute during installation');
    }
  }
  return JSON.parse(JSON.stringify(value));
}
function loadPackageTestCatalog(packageDir, manifest) {
  if (manifest.testing === undefined) return null;
  const app = manifest.name, declaration = manifest.testing;
  exact(declaration, ['version', 'catalog'], app, 'declaration');
  if (declaration.version !== 1) fail(app, 'version', 'unsupported schema version');
  if (!Array.isArray(manifest.uses) || !manifest.uses.includes('test-catalog')) fail(app, 'uses', 'declare uses: [test-catalog] so older cores refuse silently ignored catalogs');
  if (typeof declaration.catalog !== 'string' || !/\.ya?ml$/.test(declaration.catalog)) fail(app, 'catalog', 'must reference a YAML catalog');
  const root = fs.realpathSync(packageDir);
  const bytes = confinedFile(root, declaration.catalog, app, 'catalog', MAX_CATALOG_BYTES);
  let parsed;
  try { parsed = yaml.load(bytes.toString('utf8'), { schema: yaml.JSON_SCHEMA }); }
  catch (error) { fail(app, 'catalog', `invalid YAML: ${error.message}`); }
  const catalog = validatePackageTestCatalog(parsed, manifest), revisions = Object.create(null), files = new Map();
  let total = bytes.length;
  for (const test of catalog.cases) {
    const paths = [...(test.runner.kind !== 'smoke' && test.runner.scope === 'package' ? test.runner.files : []), ...(test.isolation.fixtures || [])];
    const content = [];
    for (const file of paths) {
      if (!files.has(file)) {
        const data = confinedFile(root, file, app, `cases.${test.id}.files`); total += data.length;
        if (total > MAX_TOTAL_BYTES) fail(app, 'files', 'referenced content exceeds 32 MiB');
        files.set(file, hash(data));
      }
      content.push([file, files.get(file)]);
    }
    const smoke = test.runner.kind === 'smoke' ? manifest.smoke.find(item => item.name === test.runner.smoke) : undefined;
    revisions[test.id] = hash(JSON.stringify({ test, content, smoke }));
  }
  return { catalog, revisions };
}
/** Only a fingerprint leaves the registry: local paths and credential-bearing provenance never do. */
function packageTestSource(packageDir) {
  const root = fs.realpathSync(packageDir), stamp = path.join(root, '.oshal-install.json');
  if (!fs.existsSync(stamp)) return `local:${hash(root)}`;
  const bytes = confinedFile(root, '.oshal-install.json', '(installed)', 'source', 64 * 1024);
  let source;
  try { source = JSON.parse(bytes.toString('utf8')); } catch { fail('(installed)', 'source', 'invalid installation provenance'); }
  if (!source || typeof source.repo !== 'string' || !source.repo) fail('(installed)', 'source', 'missing installer repository');
  return `store:${hash(JSON.stringify({ repo: source.repo, registry: source.registry || null }))}`;
}
module.exports = { validatePackageTestCatalog, loadPackageTestCatalog, packageTestSource };
