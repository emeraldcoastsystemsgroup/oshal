/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-157 S1: lift the manifest schedule contract out of swarm-app-loader.ts (past its 800-line budget) and add the activation declaration — `runsAs` (system | user) and `requires`, whose every entry must be a permission the app's own imported authorization catalog defines. Verbatim move of the prompt/service-route rules; the loader keeps calling one function at the same point in validation.
 *
 * @module manifest-schedule-validation
 */

import { CronExpressionParser } from 'cron-parser';
import { resolveRouteAuthMode } from '@/shared/route-auth';
import type { AuthorizationCatalog } from '@/shared/application-authorization';
import type { SwarmAppManifest } from '../types';

const MAX_SERVICE_SCHEDULE_BODY_BYTES = 16 * 1024;
const MAX_SERVICE_SCHEDULE_JSON_DEPTH = 8;
const MAX_SERVICE_SCHEDULE_JSON_ENTRIES = 256;
/** ADR-157: a service declares the permissions it needs, not a permission catalogue of its own. */
const MAX_SERVICE_SCHEDULE_REQUIRES = 16;
const PROMPT_SCHEDULE_KEYS = ['id', 'cron', 'target', 'prompt', 'targetAgent', 'scope', 'requiresConnection', 'description', 'enabled'];
const SERVICE_SCHEDULE_KEYS = ['id', 'cron', 'target', 'route', 'handler', 'body', 'scope', 'description', 'enabled', 'runsAs', 'requires'];

/** @description Whether a concrete probe path falls on a route's segment boundary.
 * @param probePath - Concrete canonical local path a declaration names.
 * @param mountPath - A declared routes[].mountPath.
 * @returns True when the probe is the mount or sits beneath it on a segment boundary.
 */
export function probeBelongsToRoute(probePath: string, mountPath: string): boolean {
  const mount = mountPath.length > 1 ? mountPath.replace(/\/+$/, '') : mountPath;
  return probePath === mount || probePath.startsWith(`${mount}/`);
}

/** @description Reject templating syntax anywhere in a parsed JSON fixture.
 * @param value - Any parsed JSON value.
 * @returns True when interpolation syntax appears in a key or a value at any depth.
 */
export function containsFixtureInterpolation(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\$\{[^}]+\}|\{\{[^}]+\}\}|<%[\s\S]*?%>|%[A-Za-z_][A-Za-z0-9_]*%/.test(value);
  }
  if (Array.isArray(value)) return value.some(containsFixtureInterpolation);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, entry]) => containsFixtureInterpolation(key) || containsFixtureInterpolation(entry),
    );
  }
  return false;
}

/** @description Whether a deterministic service target is one concrete canonical local path. */
function isCanonicalServiceSchedulePath(value: string): boolean {
  return (
    value.length <= 512 &&
    /^\/api\/[^/]+/.test(value) &&
    !/[?#\\\s]/.test(value) &&
    !value.includes('//') &&
    !/%(?:2e|2f|5c)/i.test(value) &&
    !value.split('/').some((segment) => segment === '.' || segment === '..')
  );
}

/** @description Reject non-JSON values, dangerous keys, and excessive static-body complexity. */
function validateStaticScheduleJson(value: unknown, at: string, depth = 0, budget = { entries: 0 }): void {
  if (depth > MAX_SERVICE_SCHEDULE_JSON_DEPTH) {
    throw new Error(`${at} exceeds the ${MAX_SERVICE_SCHEDULE_JSON_DEPTH}-level JSON depth limit`);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${at} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      budget.entries += 1;
      if (budget.entries > MAX_SERVICE_SCHEDULE_JSON_ENTRIES) throw new Error(`${at} has too many JSON entries`);
      validateStaticScheduleJson(entry, `${at}[${index}]`, depth + 1, budget);
    }
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${at} must contain only plain JSON values`);
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    budget.entries += 1;
    if (budget.entries > MAX_SERVICE_SCHEDULE_JSON_ENTRIES) throw new Error(`${at} has too many JSON entries`);
    if (!key || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new Error(`${at} contains an unsafe JSON key`);
    }
    validateStaticScheduleJson(entry, `${at}.${key}`, depth + 1, budget);
  }
}

/**
 * @description ADR-157: validate the activation declaration of one service-route schedule.
 * `runsAs` is the package's PROPOSAL of a principal class and grants nothing — an activation by a
 * person confirms it. `requires` names permissions from this application's own imported catalog
 * (ADR-149 §4); a name the catalog does not define is refused at load, because an activation that
 * granted it would write a permission `authorize()` can never evaluate.
 */
function validateServiceActivationDeclaration(
  schedule: Record<string, unknown>,
  at: string,
  absPath: string,
  catalog: AuthorizationCatalog | null,
): void {
  if (schedule.runsAs !== undefined && schedule.runsAs !== 'system' && schedule.runsAs !== 'user') {
    throw new Error(`Manifest ${absPath}: ${at}.runsAs must be system or user`);
  }
  if (schedule.requires === undefined) return;
  if (!Array.isArray(schedule.requires) || schedule.requires.length === 0) {
    throw new Error(`Manifest ${absPath}: ${at}.requires, when present, must be a non-empty array of permission names`);
  }
  if (schedule.requires.length > MAX_SERVICE_SCHEDULE_REQUIRES) {
    throw new Error(`Manifest ${absPath}: ${at}.requires may name at most ${MAX_SERVICE_SCHEDULE_REQUIRES} permissions`);
  }
  const seen = new Set<string>();
  for (const entry of schedule.requires as unknown[]) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`Manifest ${absPath}: ${at}.requires entries must be non-empty permission names`);
    }
    if (seen.has(entry)) throw new Error(`Manifest ${absPath}: ${at}.requires names "${entry}" twice`);
    seen.add(entry);
  }
  if (!catalog) {
    throw new Error(
      `Manifest ${absPath}: ${at}.requires names permissions but this app imports no authorization catalog ` +
        '(ADR-149 §4) — a service can only require permissions its own catalog defines',
    );
  }
  const undefinedNames = [...seen].filter((name) => !Object.prototype.hasOwnProperty.call(catalog.permissions, name));
  if (undefinedNames.length > 0) {
    throw new Error(
      `Manifest ${absPath}: ${at}.requires names permission(s) this app's authorization catalog does not define: ` +
        `${undefinedNames.join(', ')}. Known permissions: ${Object.keys(catalog.permissions).join(', ') || '(none)'}`,
    );
  }
}

/**
 * @description Validate recurring manifest jobs at the package trust boundary. Prompt schedules
 * retain the established contract. A service-route schedule is deliberately narrower: framework
 * scope only, a named compiled export, static JSON only, and an exact path owned by an
 * auth:`service` route — plus the ADR-157 activation declaration.
 *
 * @param manifest - The parsed manifest under validation.
 * @param absPath - Absolute manifest path, used verbatim in every error message.
 * @param catalog - The application's imported authorization catalog, or null when it imports none.
 * @returns Nothing; every violation throws with the offending declaration named.
 */
export function validateScheduleDeclarations(
  manifest: SwarmAppManifest,
  absPath: string,
  catalog: AuthorizationCatalog | null = null,
): void {
  if (manifest.schedules === undefined) return;
  if (!Array.isArray(manifest.schedules) || manifest.schedules.length === 0) {
    throw new Error(`Manifest ${absPath}: schedules, when present, must be a non-empty array`);
  }
  const ids = new Set<string>();
  for (const [index, value] of manifest.schedules.entries()) {
    const at = `schedules[${index}]`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Manifest ${absPath}: ${at} must be an object`);
    }
    const schedule = value as unknown as Record<string, unknown>;
    const id = typeof schedule.id === 'string' ? schedule.id.trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new Error(`Manifest ${absPath}: ${at}.id must be a lowercase slug`);
    }
    if (ids.has(id)) throw new Error(`Manifest ${absPath}: duplicate schedule id "${id}"`);
    ids.add(id);
    validateScheduleCadence(schedule, at, absPath);
    const target = schedule.target === undefined ? 'prompt' : schedule.target;
    if (target !== 'prompt' && target !== 'service-route') {
      throw new Error(`Manifest ${absPath}: ${at}.target must be prompt or service-route`);
    }
    if (target === 'prompt') {
      validatePromptSchedule(schedule, at, absPath);
      continue;
    }
    validateServiceRouteSchedule(manifest, schedule, at, absPath);
    validateServiceActivationDeclaration(schedule, at, absPath, catalog);
  }
}

/** @description Validate the fields every schedule shares: cadence, enablement and label. */
function validateScheduleCadence(schedule: Record<string, unknown>, at: string, absPath: string): void {
  const cron = typeof schedule.cron === 'string' ? schedule.cron.trim() : '';
  if (cron.split(/\s+/).length !== 5) {
    throw new Error(`Manifest ${absPath}: ${at}.cron must be a standard five-field cron expression`);
  }
  try {
    CronExpressionParser.parse(cron, { currentDate: new Date('2026-01-01T00:00:00.000Z') }).next();
  } catch {
    throw new Error(`Manifest ${absPath}: ${at}.cron is invalid`);
  }
  if (schedule.enabled !== undefined && typeof schedule.enabled !== 'boolean') {
    throw new Error(`Manifest ${absPath}: ${at}.enabled, when present, must be a boolean`);
  }
  if (schedule.description !== undefined && (typeof schedule.description !== 'string' || !schedule.description.trim())) {
    throw new Error(`Manifest ${absPath}: ${at}.description, when present, must be a non-empty string`);
  }
}

/** @description The established prompt-target contract, unchanged by ADR-157. */
function validatePromptSchedule(schedule: Record<string, unknown>, at: string, absPath: string): void {
  const unknown = Object.keys(schedule).filter((key) => !PROMPT_SCHEDULE_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`Manifest ${absPath}: ${at} has unknown field(s): ${unknown.join(', ')}`);
  if (typeof schedule.prompt !== 'string' || !schedule.prompt.trim()) {
    throw new Error(`Manifest ${absPath}: ${at}.prompt must be a non-empty string`);
  }
  if (schedule.targetAgent !== undefined && (typeof schedule.targetAgent !== 'string' || !schedule.targetAgent.trim())) {
    throw new Error(`Manifest ${absPath}: ${at}.targetAgent, when present, must be a non-empty string`);
  }
  if (schedule.scope !== undefined && schedule.scope !== 'framework' && schedule.scope !== 'per-user') {
    throw new Error(`Manifest ${absPath}: ${at}.scope must be framework or per-user`);
  }
  if (schedule.requiresConnection !== undefined && (typeof schedule.requiresConnection !== 'string' || !schedule.requiresConnection.trim())) {
    throw new Error(`Manifest ${absPath}: ${at}.requiresConnection, when present, must be a non-empty string`);
  }
}

/** @description The deterministic service-route contract: one named export behind one service route. */
function validateServiceRouteSchedule(
  manifest: SwarmAppManifest,
  schedule: Record<string, unknown>,
  at: string,
  absPath: string,
): void {
  const unknown = Object.keys(schedule).filter((key) => !SERVICE_SCHEDULE_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`Manifest ${absPath}: ${at} has unknown field(s): ${unknown.join(', ')}`);
  if (schedule.scope !== undefined && schedule.scope !== 'framework') {
    throw new Error(`Manifest ${absPath}: ${at}.scope must be framework for service-route targets`);
  }
  const routePath = typeof schedule.route === 'string' ? schedule.route : '';
  if (!isCanonicalServiceSchedulePath(routePath)) {
    throw new Error(`Manifest ${absPath}: ${at}.route must be a concrete canonical /api/... path`);
  }
  const owner = (manifest.routes ?? [])
    .filter((route) => probeBelongsToRoute(routePath, route.mountPath))
    .sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
  if (!owner) {
    throw new Error(`Manifest ${absPath}: ${at}.route "${routePath}" is not owned by routes[].mountPath`);
  }
  if (resolveRouteAuthMode(owner) !== 'service') {
    throw new Error(`Manifest ${absPath}: ${at}.route must belong to a route whose auth mode is exactly service`);
  }
  if (typeof schedule.handler !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(schedule.handler)) {
    throw new Error(`Manifest ${absPath}: ${at}.handler must be a named JavaScript export`);
  }
  const body = schedule.body === undefined ? {} : schedule.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`Manifest ${absPath}: ${at}.body, when present, must be a static JSON object`);
  }
  validateStaticScheduleJson(body, `Manifest ${absPath}: ${at}.body`);
  if (containsFixtureInterpolation(body)) {
    throw new Error(`Manifest ${absPath}: ${at}.body contains interpolation syntax; scheduled bodies are static and cannot reference secrets`);
  }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_SERVICE_SCHEDULE_BODY_BYTES) {
    throw new Error(`Manifest ${absPath}: ${at}.body exceeds ${MAX_SERVICE_SCHEDULE_BODY_BYTES} bytes`);
  }
}
