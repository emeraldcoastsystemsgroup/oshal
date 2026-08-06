/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Standalone package-CLI validation for CORE-05 executable smoke declarations and static fixture containment.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const AUTH_MODES = ['service', 'pat', 'public'];
const MAX_FIXTURE_BYTES = 64 * 1024;

/** Whether a concrete probe lives at or below a declared mount. */
function belongsToRoute(probePath, mountPath) {
  const mount = mountPath.length > 1 ? mountPath.replace(/\/+$/, '') : mountPath;
  return probePath === mount || probePath.startsWith(`${mount}/`);
}

/** Whether a parsed fixture contains any supported templating syntax. */
function containsInterpolation(value) {
  if (typeof value === 'string') {
    return /\$\{[^}]+\}|\{\{[^}]+\}\}|<%[\s\S]*?%>|%[A-Za-z_][A-Za-z0-9_]*%/.test(value);
  }
  if (Array.isArray(value)) return value.some(containsInterpolation);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, entry]) => containsInterpolation(key) || containsInterpolation(entry));
  }
  return false;
}

/** Validate one package-local JSON fixture without allowing a symlink escape. */
function validateFixture(packageDir, at, fixturePath, errors) {
  if (path.isAbsolute(fixturePath) || !fixturePath.trim() || path.extname(fixturePath).toLowerCase() !== '.json') {
    errors.push(`${at}.bodyFixture must be a relative package-local .json path`);
    return;
  }
  const root = fs.realpathSync(packageDir);
  const candidate = path.resolve(root, fixturePath);
  if (!fs.existsSync(candidate)) {
    errors.push(`${at}.bodyFixture not found: ${fixturePath}`);
    return;
  }
  const resolved = fs.realpathSync(candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    errors.push(`${at}.bodyFixture escapes the package directory`);
    return;
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > MAX_FIXTURE_BYTES) {
    errors.push(`${at}.bodyFixture must be a regular JSON file no larger than ${MAX_FIXTURE_BYTES} bytes`);
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (containsInterpolation(parsed)) {
      errors.push(`${at}.bodyFixture contains interpolation syntax; fixtures may not reference secrets`);
    }
  } catch (error) {
    errors.push(`${at}.bodyFixture is not valid JSON: ${error.message}`);
  }
}

/**
 * Validate the self-contained portion of `smoke:` before a package is staged. The server loader
 * repeats this fail-closed check against its typed schema because the CLI and runtime are separate
 * trust boundaries.
 */
function validateSmokeDeclarations(manifest, packageDir) {
  const errors = [];
  if (manifest.smoke === undefined) return errors;
  if (!Array.isArray(manifest.smoke) || manifest.smoke.length === 0) {
    return ['smoke, when present, must be a non-empty array'];
  }
  const routes = Array.isArray(manifest.routes) ? manifest.routes : [];
  const names = new Set();
  manifest.smoke.forEach((smoke, index) => {
    const at = `smoke[${index}]`;
    if (!smoke || typeof smoke !== 'object' || Array.isArray(smoke)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const unknown = Object.keys(smoke).filter(
      (key) => !['name', 'method', 'path', 'auth', 'bodyFixture', 'expect', 'requiresAi'].includes(key),
    );
    if (unknown.length) errors.push(`${at} has unknown field(s): ${unknown.join(', ')}`);
    const name = typeof smoke.name === 'string' ? smoke.name.trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) errors.push(`${at}.name must be a lowercase slug`);
    else if (names.has(name)) errors.push(`duplicate smoke name "${name}"`);
    else names.add(name);
    if (!METHODS.includes(smoke.method)) errors.push(`${at}.method must be one of ${METHODS.join(', ')}`);
    if (!AUTH_MODES.includes(smoke.auth)) errors.push(`${at}.auth must be one of ${AUTH_MODES.join(', ')}`);

    const probePath = typeof smoke.path === 'string' ? smoke.path : '';
    const canonical = /^\/(?!\/)/.test(probePath)
      && !/[?#\\\s]/.test(probePath)
      && !probePath.includes('//')
      && !probePath.split('/').some((segment) => segment === '.' || segment === '..')
      && !/%(?:2e|2f|5c)/i.test(probePath);
    if (!canonical) errors.push(`${at}.path must be a concrete canonical root-relative path`);
    const owners = routes
      .filter((route) => route && typeof route.mountPath === 'string' && belongsToRoute(probePath, route.mountPath))
      .sort((a, b) => b.mountPath.length - a.mountPath.length);
    if (!owners.length) errors.push(`${at}.path "${probePath}" is not owned by a declared routes[].mountPath`);
    if (smoke.requiresAi !== undefined && typeof smoke.requiresAi !== 'boolean') {
      errors.push(`${at}.requiresAi must be a boolean`);
    }
    if (smoke.requiresAi === true && owners.length && owners[0].requiresAi !== true) {
      errors.push(`${at} requires AI but its owning route ${owners[0].mountPath} does not declare requiresAi: true`);
    }
    if (smoke.bodyFixture !== undefined) {
      if (typeof smoke.bodyFixture !== 'string') errors.push(`${at}.bodyFixture must be a string`);
      else if (smoke.method === 'GET' || smoke.method === 'HEAD') errors.push(`${at}.bodyFixture is not allowed for ${smoke.method}`);
      else validateFixture(packageDir, at, smoke.bodyFixture, errors);
    }

    const expectation = smoke.expect;
    if (!expectation || typeof expectation !== 'object' || Array.isArray(expectation)) {
      errors.push(`${at}.expect must be an object`);
      return;
    }
    const unknownExpectation = Object.keys(expectation).filter(
      (key) => !['status', 'jsonPointer', 'rejectValues'].includes(key),
    );
    if (unknownExpectation.length) errors.push(`${at}.expect has unknown field(s): ${unknownExpectation.join(', ')}`);
    if (!Number.isInteger(expectation.status) || expectation.status < 100 || expectation.status > 599) {
      errors.push(`${at}.expect.status must be an HTTP status integer`);
    }
    if (expectation.jsonPointer !== undefined && (
      typeof expectation.jsonPointer !== 'string'
      || (expectation.jsonPointer !== '' && !expectation.jsonPointer.startsWith('/'))
      || /~(?![01])/.test(expectation.jsonPointer)
    )) errors.push(`${at}.expect.jsonPointer must be a valid RFC 6901 pointer`);
    if (expectation.rejectValues !== undefined) {
      const scalars = Array.isArray(expectation.rejectValues)
        && expectation.rejectValues.length > 0
        && expectation.rejectValues.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item));
      if (!scalars) errors.push(`${at}.expect.rejectValues must be a non-empty scalar array`);
      if (expectation.jsonPointer === undefined) errors.push(`${at}.expect.rejectValues requires expect.jsonPointer`);
    }
  });
  return errors;
}

module.exports = { validateSmokeDeclarations };
