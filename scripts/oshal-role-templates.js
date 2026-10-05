/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Share exact application composite declarations between package CLI validation and runtime activation.
 */
'use strict';
const { readAppDependencies } = require('./oshal-app-dependencies');
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Refuse ignored authority fields in package-owned template declarations. */
function object(value, keys, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at} must be an object`);
  const unknown = Object.keys(value).filter(key => !keys.includes(key));
  if (unknown.length) throw new Error(`${at} has unknown fields: ${unknown.join(', ')}`);
  return value;
}

/** Validate exact role references; current installed catalogs remain authoritative at review. */
function validateRoleTemplates(name, value, required, dependencies) {
  if (value === undefined) return;
  if (typeof name !== 'string' || !Array.isArray(value) || !value.length || value.length > 32) {
    throw new Error('application roleTemplates must contain 1..32 named templates');
  }
  const allowed = new Set([name, ...dependencies]), ids = new Set();
  for (const item of value) {
    const template = object(item, ['id', 'version', 'label', 'members'], 'application roleTemplates[]');
    if (typeof template.id !== 'string' || !SLUG.test(template.id) || ids.has(template.id)) throw new Error('application role template id must be unique');
    ids.add(template.id);
    if (!Number.isSafeInteger(template.version) || template.version < 1) throw new Error('application role template version must be a positive integer');
    if (typeof template.label !== 'string' || !template.label.trim() || template.label.length > 128 || /[\x00-\x1f\x7f]/.test(template.label)) {
      throw new Error('application role template label must be bounded display text');
    }
    validateMembers(name, template.members, required, allowed);
  }
}

/** Require a named role for the owning app and every explicitly required component. */
function validateMembers(name, members, required, allowed) {
  if (!Array.isArray(members) || !members.length || members.length > 128) throw new Error('application role template members must contain 1..128 exact roles');
  const referenced = new Set(), edges = new Set();
  for (const item of members) {
    const member = object(item, ['app', 'role'], 'application role template member');
    if (typeof member.app !== 'string' || !allowed.has(member.app)) throw new Error('application role template member must name this application or a declared dependency');
    if (typeof member.role !== 'string' || !/^(?:@app-admin|[A-Za-z][A-Za-z0-9_.-]{0,127})$/.test(member.role)) throw new Error('application role template must name an exact catalog role or explicit legacy @app-admin adapter');
    const key = `${member.app}\0${member.role}`;
    if (edges.has(key)) throw new Error('application role template must not repeat a member role');
    edges.add(key); referenced.add(member.app);
  }
  if ([name, ...required].some(app => !referenced.has(app))) throw new Error('application role template must cover its own application and every required member');
}

/** Native applications can declare the same lifecycle without an experience presentation shell. */
function validateAuthorizationRoleTemplates(manifest) {
  const templates = manifest.authorization?.roleTemplates;
  if (templates === undefined) return;
  if (manifest.kind === 'group') throw new Error('application role templates require an ordinary application');
  if (manifest.experience?.roleTemplates !== undefined) throw new Error('application role templates must have one declaration owner');
  if (!Array.isArray(manifest.uses) || !manifest.uses.includes('application-authorization') || !manifest.uses.includes('experience-roles')) {
    throw new Error('application role templates require uses: [application-authorization, experience-roles]');
  }
  if (manifest.authorization.version !== 1 || typeof manifest.authorization.catalog !== 'string') {
    throw new Error('application role templates require a version 1 package-local authorization catalog');
  }
  const dependencies = readAppDependencies(manifest);
  validateRoleTemplates(manifest.name, templates, dependencies.required.apps,
    new Set([...dependencies.required.apps, ...dependencies.optional.apps]));
}

module.exports = { validateRoleTemplates, validateAuthorizationRoleTemplates };
