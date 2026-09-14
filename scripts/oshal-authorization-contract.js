/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 */
/* ADR-149 shared CLI/runtime contract. Pure catalog validation; loading is package-confined. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const TIERS = ['deny', 'viewer', 'editor', 'admin'];
const EFFECTS = { read: 1, write: 2, export: 2, execute: 2, administer: 3 };
const SCOPES = ['own', 'team', 'tenant'];
const KINDS = ['http', 'tools', 'bots', 'jobs', 'artifactActions'];
const MAX_BYTES = 128 * 1024;
function fail(message) { throw new Error(`Invalid application authorization: ${message}`); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  if (Object.keys(value).length > 256) fail(`${label} exceeds 256 entries`);
  return value;
}
function exact(value, keys, label) {
  object(value, label);
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`${label} contains unknown fields`);
}
function id(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/.test(value)
    || ['constructor', 'prototype', '__proto__'].includes(value)) fail(`${label} is an invalid identifier`);
}
function list(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) fail(`${label} must contain 1-256 entries`);
  if (new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail(`${label} contains duplicates`);
}
function has(record, key) { return Object.prototype.hasOwnProperty.call(record, key); }
function route(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^\/(?:[A-Za-z0-9_-]+|:[A-Za-z][A-Za-z0-9_]*)(?:\/(?:[A-Za-z0-9_-]+|:[A-Za-z][A-Za-z0-9_]*))*$/.test(value)) {
    if (value !== '/') fail('HTTP path must use literal segments or named parameters');
  }
}
function boundedJson(value) {
  const seen = new WeakSet(); let nodes = 0; let bytes = 0;
  function visit(item, depth) {
    if (++nodes > 20_000 || depth > 32) fail('catalog exceeds structural limits');
    if (typeof item === 'string') bytes += Buffer.byteLength(item, 'utf8');
    if (item && typeof item === 'object') {
      if (seen.has(item)) fail('catalog aliases and cycles are unsupported');
      seen.add(item);
      for (const [key, child] of Object.entries(item)) {
        bytes += Buffer.byteLength(key, 'utf8'); visit(child, depth + 1);
      }
    }
    if (bytes > MAX_BYTES) fail('catalog exceeds size limit');
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value) || '', 'utf8') > MAX_BYTES) fail('catalog exceeds size limit');
}
function validateAuthorizationCatalog(value) {
  boundedJson(value);
  exact(value, ['version', 'resources', 'permissions', 'roles', 'bindings'], 'catalog');
  if (value.version !== 1) fail('unsupported version');
  object(value.resources, 'resources'); object(value.permissions, 'permissions');
  object(value.roles, 'roles'); exact(value.bindings, KINDS, 'bindings');
  if (!Object.keys(value.permissions).length) fail('permissions must not be empty');
  for (const [name, resource] of Object.entries(value.resources)) {
    id(name, 'resource'); exact(resource, ['scopes', 'fieldSets'], name); list(resource.scopes, `${name}.scopes`);
    if (resource.scopes.some(scope => !SCOPES.includes(scope))) fail('unknown resource scope');
    if (resource.fieldSets !== undefined) {
      object(resource.fieldSets, 'fieldSets');
      for (const [fieldSet, fields] of Object.entries(resource.fieldSets)) {
        id(fieldSet, 'field set'); list(fields, 'fields'); fields.forEach(field => id(field, 'field'));
      }
    }
  }
  for (const [name, permission] of Object.entries(value.permissions)) {
    id(name, 'permission'); exact(permission, ['resource', 'effect', 'minimumTier'], name);
    if (!has(value.resources, permission.resource)) fail(`unknown resource for ${name}`);
    if (!has(EFFECTS, permission.effect) || !TIERS.includes(permission.minimumTier)
      || TIERS.indexOf(permission.minimumTier) < EFFECTS[permission.effect]) fail(`effect/tier contradiction for ${name}`);
  }
  for (const [name, role] of Object.entries(value.roles)) {
    id(name, 'role'); exact(role, ['tier', 'grants', 'sensitive'], name); list(role.grants, `${name}.grants`);
    if (!TIERS.includes(role.tier) || role.tier === 'deny') fail(`invalid role tier for ${name}`);
    if (role.sensitive !== undefined && typeof role.sensitive !== 'boolean') fail('sensitive must be boolean');
    for (const grant of role.grants) {
      exact(grant, ['permission', 'scope', 'fields'], 'grant');
      if (!has(value.permissions, grant.permission)) fail(`unknown grant permission in ${name}`);
      const permission = value.permissions[grant.permission];
      const resource = value.resources[permission.resource];
      if (!resource.scopes.includes(grant.scope)) fail(`unsupported grant scope in ${name}`);
      if (TIERS.indexOf(role.tier) < TIERS.indexOf(permission.minimumTier)) fail(`role tier contradicts grant in ${name}`);
      if (grant.fields !== undefined && (!resource.fieldSets || !has(resource.fieldSets, grant.fields))) fail('unknown grant field set');
      if (resource.fieldSets && Object.keys(resource.fieldSets).length && grant.fields === undefined) fail('field set required for protected resource');
    }
  }
  for (const [kind, bindings] of Object.entries(value.bindings)) {
    list(bindings, `${kind} bindings`); const seen = new Set(); const routes = [];
    for (const binding of bindings) {
      exact(binding, kind === 'http' ? ['id', 'method', 'path', 'allOf'] : ['id', 'allOf'], 'binding');
      id(binding.id, 'binding'); if (seen.has(binding.id)) fail('duplicate binding id'); seen.add(binding.id);
      list(binding.allOf, 'allOf');
      if (binding.allOf.some(permission => !has(value.permissions, permission))) fail('unknown bound permission');
      if (kind === 'http') {
        if (!['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(binding.method)) fail('unsupported HTTP method');
        route(binding.path); const parts = binding.path.split('/');
        for (const prior of routes) {
          if (prior.method === binding.method && prior.parts.length === parts.length
            && prior.parts.every((part, i) => part === parts[i] || part.startsWith(':') || parts[i].startsWith(':'))) fail('overlapping HTTP bindings');
        }
        routes.push({ method: binding.method, parts });
      }
    }
  }
  return JSON.parse(JSON.stringify(value));
}
function parseAuthorizationCatalog(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_BYTES) fail('catalog exceeds size limit');
  return validateAuthorizationCatalog(yaml.load(source, { schema: yaml.JSON_SCHEMA }));
}
function loadApplicationAuthorization(packageDir, manifest) {
  if (manifest.authorization === undefined) return null;
  if (!Array.isArray(manifest.uses) || !manifest.uses.includes('application-authorization')) fail('catalog requires uses: [application-authorization] so older cores refuse activation');
  const declaration = manifest.authorization;
  exact(declaration, ['version', 'catalog'], 'authorization');
  if (declaration.version !== 1) fail('unsupported declaration version');
  const file = declaration.catalog;
  if (typeof file !== 'string' || file.length > 256 || !/^[A-Za-z0-9_./-]+\.ya?ml$/.test(file)
    || file.startsWith('/') || file.split('/').some(segment => !segment || segment === '.' || segment === '..')) fail('catalog path escapes package');
  const root = fs.realpathSync(packageDir); let target = root;
  for (const segment of file.split('/')) { target = path.join(target, segment); if (fs.lstatSync(target).isSymbolicLink()) fail('catalog symlinks are forbidden'); }
  const resolved = fs.realpathSync(target); const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('catalog path escapes package');
  const stat = fs.statSync(resolved); if (!stat.isFile() || stat.size > MAX_BYTES) fail('catalog must be a bounded file');
  return parseAuthorizationCatalog(fs.readFileSync(resolved, 'utf8'));
}
module.exports = { validateAuthorizationCatalog, parseAuthorizationCatalog, loadApplicationAuthorization };
