/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Permit explicit asset filenames while refusing dot-segment traversal and keeping parameter grammar unchanged.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | A bots binding may name its agentId as a canonical lowercase UUID, which can begin with a digit (Intelligent Sales' concierge is 15000000-…-0001). Before this the package could not bind its own bot, and an unbound bot is refused for everyone once a catalog exists. Every other binding kind keeps the identifier rule.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Import native application role templates through the same bounded template validator used by experience packages.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Read a kernel manifest's catalog the way both runtimes name it. swarm-apps/jarvis.yaml declares `catalog: swarm-apps/jarvis-authorization.yaml`, spelled from the platform root because the native kernel reads these declarations with the root as their package directory (oshal-kernel crates/oshald/src/platform_apps.rs), and the running native kernel reads this very tree (OSHAL_PLATFORM_DIR), so the manifest must keep that spelling. This loader joined that spelling to swarm-apps/ itself, so jarvis.yaml failed to load with ENOENT 'swarm-apps/swarm-apps' (the evidence nightly's audit proof, the manifests gate, and every legacy boot). For a manifest in a directory named swarm-apps, a `swarm-apps/` prefix now names a file inside that same directory: the spelling changes, the package boundary does not, and manifest-bot-runtime.ts already reads kernel-manifest personas root-relative. Also exports declaredCatalogFiles, so manifest scans stop treating a catalog that a sibling manifest declares (swarm-apps/jarvis-authorization.yaml) as an application manifest of its own.
 */
/* ADR-149 shared CLI/runtime contract. Pure catalog validation; loading is package-confined. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { validateAuthorizationRoleTemplates } = require('./oshal-role-templates');
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
// A bots binding names the package's agentId, and the runtime matches it verbatim
// (operation = agentId). Agent ids are UUIDs, which may begin with a digit, so that one kind
// also accepts a canonical lowercase UUID; every other kind keeps the identifier rule.
const AGENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function bindingId(kind, value) {
  if (kind === 'bots' && typeof value === 'string' && AGENT_UUID.test(value)) return;
  id(value, 'binding');
}
function list(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) fail(`${label} must contain 1-256 entries`);
  if (new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail(`${label} contains duplicates`);
}
function has(record, key) { return Object.prototype.hasOwnProperty.call(record, key); }
function route(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^\/(?:[A-Za-z0-9_.-]+|:[A-Za-z][A-Za-z0-9_]*)(?:\/(?:[A-Za-z0-9_.-]+|:[A-Za-z][A-Za-z0-9_]*))*$/.test(value)
    || value.split('/').some(segment => segment === '.' || segment === '..')) {
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
      bindingId(kind, binding.id); if (seen.has(binding.id)) fail('duplicate binding id'); seen.add(binding.id);
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
/*
 * Kernel-resident platform declarations live in the platform's swarm-apps/ directory and name their
 * files from the platform ROOT - the convention the native kernel reads them with, and the one
 * manifest-bot-runtime.ts applies to their personas. So `swarm-apps/<file>`, from a manifest in a
 * directory named swarm-apps, is <file> inside that directory. Only the spelling is translated:
 * every segment is still validated and the result is still confined to that directory.
 */
const KERNEL_MANIFEST_DIR = 'swarm-apps';
function packageRelativeCatalog(packageDir, file) {
  const prefix = `${KERNEL_MANIFEST_DIR}/`;
  return path.basename(packageDir) === KERNEL_MANIFEST_DIR && file.startsWith(prefix) ? file.slice(prefix.length) : file;
}
/**
 * @description The authorization catalogs that the flat manifests of one directory declare, as file
 * names directly in it. Such a file belongs to the manifest naming it, whose load parses and validates
 * it, so a manifest scan must not load it as an application of its own. A file shaped like a manifest
 * (a top-level `name`) is never claimed, so no manifest can hide another from a scan.
 * @param {string} dir - A directory of flat *.yaml manifests (swarm-apps/, deployed-apps/, ...).
 * @returns {Set<string>} The claimed file names; empty when the directory cannot be read.
 */
function declaredCatalogFiles(dir) {
  const docs = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => /\.ya?ml$/.test(name)); } catch { return new Set(); }
  for (const name of names) {
    try { docs.set(name, yaml.load(fs.readFileSync(path.join(dir, name), 'utf8'))); } catch { docs.set(name, null); }
  }
  const claimed = new Set();
  for (const doc of docs.values()) {
    const catalog = doc && typeof doc === 'object' && doc.authorization ? doc.authorization.catalog : undefined;
    if (typeof catalog !== 'string') continue;
    const file = packageRelativeCatalog(path.resolve(dir), catalog);
    const target = docs.get(file);
    if (target && typeof target === 'object' && !Object.prototype.hasOwnProperty.call(target, 'name')) claimed.add(file);
  }
  return claimed;
}
function loadApplicationAuthorization(packageDir, manifest) {
  if (manifest.authorization === undefined) return null;
  if (!Array.isArray(manifest.uses) || !manifest.uses.includes('application-authorization')) fail('catalog requires uses: [application-authorization] so older cores refuse activation');
  const declaration = manifest.authorization;
  exact(declaration, ['version', 'catalog', 'roleTemplates'], 'authorization');
  if (declaration.version !== 1) fail('unsupported declaration version');
  validateAuthorizationRoleTemplates(manifest);
  const file = declaration.catalog;
  if (typeof file !== 'string' || file.length > 256 || !/^[A-Za-z0-9_./-]+\.ya?ml$/.test(file)
    || file.startsWith('/') || file.split('/').some(segment => !segment || segment === '.' || segment === '..')) fail('catalog path escapes package');
  const root = fs.realpathSync(packageDir); let target = root;
  for (const segment of packageRelativeCatalog(root, file).split('/')) { target = path.join(target, segment); if (fs.lstatSync(target).isSymbolicLink()) fail('catalog symlinks are forbidden'); }
  const resolved = fs.realpathSync(target); const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('catalog path escapes package');
  const stat = fs.statSync(resolved); if (!stat.isFile() || stat.size > MAX_BYTES) fail('catalog must be a bounded file');
  return parseAuthorizationCatalog(fs.readFileSync(resolved, 'utf8'));
}
module.exports = { validateAuthorizationCatalog, parseAuthorizationCatalog, loadApplicationAuthorization, declaredCatalogFiles };
