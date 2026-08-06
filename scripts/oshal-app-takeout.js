/**
 * Static authoring checks for package-contributed Google Takeout slices.
 * The TypeScript manifest loader repeats these checks as the runtime trust authority.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Add pre-install shape, path, byte-limit, and module-confinement validation.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const ABSOLUTE_MAX_BYTES = 128 * 1024 * 1024;

function canonicalSuffix(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 512) return false;
  if (value.startsWith('/') || value.includes('\\') || /[\0?#]/.test(value) || value.includes('//')) return false;
  const segments = value.split('/');
  return segments.length >= 2 && segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Return authoring errors/warnings without executing package code. */
function validateTakeoutDeclarations(manifest, packageDir) {
  const errors = [];
  const warnings = [];
  if (manifest.takeout === undefined) return { errors, warnings };
  if (!Array.isArray(manifest.takeout) || manifest.takeout.length === 0) {
    return { errors: ['takeout, when present, must be a non-empty array'], warnings };
  }
  if (manifest.takeout.length > 16) errors.push('takeout may declare at most 16 slices');

  const kinds = new Set();
  const archivePaths = new Set();
  const realRoot = fs.realpathSync(packageDir);
  manifest.takeout.forEach((declaration, index) => {
    const at = `takeout[${index}]`;
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const unknown = Object.keys(declaration).filter(
      (key) => !['kind', 'label', 'pathSuffix', 'htmlPathSuffix', 'maxBytes', 'module', 'handler'].includes(key),
    );
    if (unknown.length) errors.push(`${at} has unknown field(s): ${unknown.join(', ')}`);

    if (typeof declaration.kind !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(declaration.kind)) {
      errors.push(`${at}.kind must be a lowercase slug`);
    } else if (kinds.has(declaration.kind)) {
      errors.push(`duplicate Takeout kind "${declaration.kind}"`);
    } else kinds.add(declaration.kind);

    if (
      typeof declaration.label !== 'string'
      || declaration.label !== declaration.label.trim()
      || declaration.label.length < 1
      || declaration.label.length > 128
      || /[\0-\x1f\x7f]/.test(declaration.label)
    ) {
      errors.push(`${at}.label must be 1..128 trimmed characters`);
    }

    for (const [field, optional] of [['pathSuffix', false], ['htmlPathSuffix', true]]) {
      const value = declaration[field];
      if (optional && value === undefined) continue;
      if (!canonicalSuffix(value)) {
        errors.push(`${at}.${field} must be a canonical relative archive suffix`);
      } else {
        const expectedExtension = field === 'pathSuffix' ? '.json' : '.html';
        if (!value.toLowerCase().startsWith('takeout/') || !value.toLowerCase().endsWith(expectedExtension)) {
          errors.push(`${at}.${field} must identify a Takeout/... ${expectedExtension.slice(1).toUpperCase()} file`);
        }
        const lower = value.toLowerCase();
        if (archivePaths.has(lower)) errors.push(`duplicate Takeout archive path "${value}"`);
        else archivePaths.add(lower);
      }
    }

    const maxBytes = declaration.maxBytes === undefined ? DEFAULT_MAX_BYTES : declaration.maxBytes;
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > ABSOLUTE_MAX_BYTES) {
      errors.push(`${at}.maxBytes must be an integer from 1 through ${ABSOLUTE_MAX_BYTES}`);
    }

    const modulePath = declaration.module;
    if (
      typeof modulePath !== 'string'
      || !modulePath.endsWith('.js')
      || path.isAbsolute(modulePath)
      || modulePath.includes('\\')
      || modulePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      errors.push(`${at}.module must be a package-relative compiled .js path`);
    } else {
      const declared = path.resolve(realRoot, modulePath);
      if (!within(realRoot, declared)) {
        errors.push(`${at}.module escapes the package`);
      } else if (!fs.existsSync(declared)) {
        warnings.push(`${at}.module not present yet: ${modulePath} — compile it before install`);
      } else if (!within(realRoot, fs.realpathSync(declared))) {
        errors.push(`${at}.module resolves outside the package through a symlink`);
      }
    }

    if (typeof declaration.handler !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(declaration.handler)) {
      errors.push(`${at}.handler must be a JavaScript export name`);
    }
  });
  return { errors, warnings };
}

module.exports = { validateTakeoutDeclarations };
