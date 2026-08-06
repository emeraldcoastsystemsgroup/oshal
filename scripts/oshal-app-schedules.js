/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pre-install validation for prompt and deterministic service-route manifest schedules, mirroring the runtime trust boundary without executing package code.
 */

'use strict';

const { CronExpressionParser } = require('cron-parser');

const MAX_BODY_BYTES = 16 * 1024;
const MAX_DEPTH = 8;
const MAX_ENTRIES = 256;

function belongsTo(path, mountPath) {
  const mount = mountPath.length > 1 ? mountPath.replace(/\/+$/, '') : mountPath;
  return path === mount || path.startsWith(`${mount}/`);
}

function canonicalRoute(path) {
  return typeof path === 'string' && path.length <= 512 && /^\/api\/[^/]+/.test(path) &&
    !/[?#\\\s]/.test(path) && !path.includes('//') && !/%(?:2e|2f|5c)/i.test(path) &&
    !path.split('/').some((segment) => segment === '.' || segment === '..');
}

function containsInterpolation(value) {
  if (typeof value === 'string') return /\$\{[^}]+\}|\{\{[^}]+\}\}|<%[\s\S]*?%>|%[A-Za-z_][A-Za-z0-9_]*%/.test(value);
  if (Array.isArray(value)) return value.some(containsInterpolation);
  return value && typeof value === 'object' && Object.entries(value)
    .some(([key, entry]) => containsInterpolation(key) || containsInterpolation(entry));
}

function validateJson(value, at, errors, depth = 0, budget = { entries: 0 }) {
  if (depth > MAX_DEPTH) { errors.push(`${at} exceeds the ${MAX_DEPTH}-level JSON depth limit`); return; }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) errors.push(`${at} contains a non-finite number`); return; }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      budget.entries += 1;
      if (budget.entries > MAX_ENTRIES) return;
      validateJson(entry, `${at}[${index}]`, errors, depth + 1, budget);
    });
    if (budget.entries > MAX_ENTRIES) errors.push(`${at} has too many JSON entries`);
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    errors.push(`${at} must contain only plain JSON values`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    budget.entries += 1;
    if (budget.entries > MAX_ENTRIES) { errors.push(`${at} has too many JSON entries`); return; }
    if (!key || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      errors.push(`${at} contains an unsafe JSON key`);
      return;
    }
    validateJson(entry, `${at}.${key}`, errors, depth + 1, budget);
  }
}

/** Validate schedules without loading any package module. */
function validateScheduleDeclarations(manifest) {
  const errors = [];
  if (manifest.schedules === undefined) return errors;
  if (!Array.isArray(manifest.schedules) || manifest.schedules.length === 0) {
    return ['schedules, when present, must be a non-empty array'];
  }
  const ids = new Set();
  manifest.schedules.forEach((schedule, index) => {
    const at = `schedules[${index}]`;
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) { errors.push(`${at} must be an object`); return; }
    const id = typeof schedule.id === 'string' ? schedule.id.trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) errors.push(`${at}.id must be a lowercase slug`);
    else if (ids.has(id)) errors.push(`duplicate schedule id "${id}"`);
    ids.add(id);

    const cron = typeof schedule.cron === 'string' ? schedule.cron.trim() : '';
    if (cron.split(/\s+/).length !== 5) errors.push(`${at}.cron must be a standard five-field cron expression`);
    else { try { CronExpressionParser.parse(cron, { currentDate: new Date('2026-01-01T00:00:00Z') }).next(); } catch { errors.push(`${at}.cron is invalid`); } }
    if (schedule.enabled !== undefined && typeof schedule.enabled !== 'boolean') errors.push(`${at}.enabled must be a boolean`);
    if (schedule.description !== undefined && (typeof schedule.description !== 'string' || !schedule.description.trim())) errors.push(`${at}.description must be non-empty`);

    const target = schedule.target === undefined ? 'prompt' : schedule.target;
    if (target === 'prompt') {
      const unknown = Object.keys(schedule).filter((key) => !['id', 'cron', 'target', 'prompt', 'targetAgent', 'scope', 'requiresConnection', 'description', 'enabled'].includes(key));
      if (unknown.length) errors.push(`${at} has unknown field(s): ${unknown.join(', ')}`);
      if (typeof schedule.prompt !== 'string' || !schedule.prompt.trim()) errors.push(`${at}.prompt must be non-empty`);
      if (schedule.scope !== undefined && !['framework', 'per-user'].includes(schedule.scope)) errors.push(`${at}.scope must be framework or per-user`);
      return;
    }
    if (target !== 'service-route') { errors.push(`${at}.target must be prompt or service-route`); return; }
    const unknown = Object.keys(schedule).filter((key) => !['id', 'cron', 'target', 'route', 'handler', 'body', 'scope', 'description', 'enabled'].includes(key));
    if (unknown.length) errors.push(`${at} has unknown field(s): ${unknown.join(', ')}`);
    if (schedule.scope !== undefined && schedule.scope !== 'framework') errors.push(`${at}.scope must be framework for service-route targets`);
    if (!canonicalRoute(schedule.route)) { errors.push(`${at}.route must be a concrete canonical /api/... path`); return; }
    const owner = (manifest.routes || []).filter((route) => route && typeof route.mountPath === 'string' && belongsTo(schedule.route, route.mountPath))
      .sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
    if (!owner) errors.push(`${at}.route is not owned by routes[].mountPath`);
    else if (owner.auth !== 'service') errors.push(`${at}.route must belong to a route whose auth mode is exactly service`);
    if (typeof schedule.handler !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(schedule.handler)) errors.push(`${at}.handler must be a named JavaScript export`);
    const body = schedule.body === undefined ? {} : schedule.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) errors.push(`${at}.body must be a static JSON object`);
    else {
      validateJson(body, `${at}.body`, errors);
      if (containsInterpolation(body)) errors.push(`${at}.body contains interpolation syntax`);
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) errors.push(`${at}.body exceeds ${MAX_BODY_BYTES} bytes`);
    }
  });
  return errors;
}

module.exports = { validateScheduleDeclarations };
