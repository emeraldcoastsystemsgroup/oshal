/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L1 static log guard. Part 1 runs the guard over the real tree: no logger call in src/features/location or a location route may carry location data (red the moment one is planted). Part 2 plants each leak shape the ADR names - a depth-3 telemetry object (telemetry.position.lat), an error carrying a URL, spreads, printf arguments, console, detached logger methods, child options - and requires the exact rule to fire, and requires the accepted id/count/label/locationSafeError forms to pass. Part 3 builds a scratch tree with the repository layout and proves scope DISCOVERY finds location code however it is wired (slice files, location-named route files, full-path declarations, const/template paths, mounts followed through a local const and a barrel) while leaving server.ts, shared middleware and unrelated routes out, and that a handler declared outside src/app/routes or an unfollowable mount is itself a violation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fixes: the two done-when leaks through a DESTRUCTURED logger method (`const { info } = log; info({ deviceId, telemetry })`, `const { error } = log; error({ err })`) now go red, with every other destructuring spelling (renamed, computed, child, factory call, parameter default or type, nested, assignment) and element access (`log[level](…)`, `log['warn']` as a value); non-logger destructuring still passes. The scratch tree gains /api/location paths held in IMPORTED consts - a server.ts mount through a local `export { X as Y }` list, and declarations through a renaming '@/' barrel (named and namespace import) in route files that never contain the word location - plus a function-local const path; each must enter scope while the paths modules and an imported tickets path stay out.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as sharedLogger from '@/shared/logger';
import {
  checkLocationLogSafety,
  scanLocationLogSource,
  SANCTIONED_ERROR_HELPER,
  SANCTIONED_LOGGER_MODULE,
  type LocationLogViolation,
} from '../helpers/location-log-guard';

const ROOT = process.cwd();
const SCAN_TIMEOUT_MS = 120_000;
const IMPORTS = "import { createChildLogger, locationSafeError } from '@/shared/logger';\n";
const HEADER = `${IMPORTS}const log = createChildLogger({ module: 'location' });\n`;
const TELEMETRY = "const telemetry = { position: { lat: -12.5, lon: -31.25 } };\n";
const THROWN = "const err = new Error('GET https://geo.example/reverse?lat=-12.5&lon=-31.25 failed');\n";

/** The rules the guard reports for one planted body in a location slice file. */
function rulesOf(body: string, header = HEADER): string[] {
  return scanLocationLogSource('src/features/location/probe.ts', header + body).map((v) => v.rule);
}

/** A compact, comparable view of a violation list. */
function pairs(violations: LocationLogViolation[]): string[] {
  return violations.map((v) => `${v.file} ${v.rule}`).sort();
}

describe('ADR-169 L1 location log guard: the real tree', () => {
  it('no logger call in src/features/location or a location route carries location data', () => {
    const result = checkLocationLogSafety(ROOT);
    const scanned = result.files.length ? result.files.join(', ') : '(no location code yet)';
    expect(result.violations, `scanned: ${scanned}`).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it('the sanctioned error helper is a real export of the logger barrel, not a name the guard invented', () => {
    expect(SANCTIONED_LOGGER_MODULE).toBe('@/shared/logger');
    expect(SANCTIONED_ERROR_HELPER).toBe('locationSafeError');
    expect(typeof (sharedLogger as Record<string, unknown>)[SANCTIONED_ERROR_HELPER]).toBe('function');
  });
});

describe('ADR-169 L1 location log guard: planted leaks go red', () => {
  it('a depth-3 telemetry object (telemetry.position.lat) is refused in every spelling', () => {
    const telemetry = "const telemetry = { position: { lat: -12.5, lon: -31.25 } };\n";
    expect(rulesOf(`${telemetry}log.info({ deviceId: 'd1', telemetry }, 'fix received');`)).toEqual(['key-not-allowlisted']);
    expect(rulesOf(`${telemetry}log.info({ deviceId: telemetry.position.lat }, 'fix');`)).toEqual(['value-not-scalar']);
    expect(rulesOf("log.info({ ruleId: 'r1', telemetry: { position: { lat: -12.5 } } });")).toEqual(['key-not-allowlisted']);
    expect(rulesOf(`${telemetry}log.info(telemetry);`)).toEqual(['merge-object-not-inline']);
    expect(rulesOf(`${telemetry}log.info({ ...telemetry });`)).toEqual(['spread']);
    expect(rulesOf(`${telemetry}log.info(\`fix at \${telemetry.position.lat}\`);`)).toEqual(['unsafe-message']);
    expect(rulesOf(`${telemetry}log.info({ ruleId: 'r1' }, 'fix %d', telemetry.position.lat);`)).toEqual(['interpolation-args']);
    expect(rulesOf(`${telemetry}log.info({ lat: telemetry.position.lat, lon: telemetry.position.lon });`))
      .toEqual(['key-not-allowlisted', 'key-not-allowlisted']);
  });

  it('an error carrying a URL is refused unless it goes through locationSafeError from the logger barrel', () => {
    const thrown = "const err = new Error('GET https://geo.example/reverse?lat=-12.5&lon=-31.25 failed');\n";
    expect(rulesOf(`${thrown}log.error({ err }, 'reverse lookup failed');`)).toEqual(['error-object']);
    expect(rulesOf(`${thrown}log.error(err);`)).toEqual(['merge-object-not-inline']);
    expect(rulesOf(`${thrown}log.error({ err: String(err) });`)).toEqual(['error-object']);
    expect(rulesOf(`${thrown}log.error({ err: err.message });`)).toEqual(['error-object']);
    expect(rulesOf(`${thrown}log.warn({ reason: err.message });`)).toEqual(['label-not-literal']);
    expect(rulesOf("log.error({ requestId: 'q1', url: req.originalUrl });")).toEqual(['key-not-allowlisted']);
    const localLookalike = "function locationSafeError(e: unknown) { return e; }\nconst log = { error: (..._a: unknown[]) => undefined };\n";
    expect(rulesOf(`${thrown}log.error({ err: locationSafeError(err) });`, localLookalike)).toEqual(['error-object']);
  });

  it('console, detached logger methods and child-logger options are refused', () => {
    expect(rulesOf("console.log({ lat: -12.5 });")).toEqual(['console']);
    expect(rulesOf("fetchFix().catch(log.error);")).toEqual(['indirect-logger']);
    expect(rulesOf("const warn = log.warn;")).toEqual(['indirect-logger']);
    expect(rulesOf("log.info.call(log, { lat: 1 });")).toEqual(['indirect-logger']);
    expect(rulesOf("log['info']({ coords: [1, 2] });")).toEqual(['key-not-allowlisted']);
    expect(rulesOf("log.child({ component: 'evaluator' }, { redact: [] });")).toEqual(['child-options']);
    expect(rulesOf("createChildLogger({ module: 'location', coords: here });")).toEqual(['key-not-allowlisted']);
    expect(rulesOf("log.child({ module: placeName });")).toEqual(['label-not-literal']);
    // Destructured off the logger, a method's later bare call would escape every argument rule.
    expect(rulesOf(`${TELEMETRY}const { info } = log;\ninfo({ deviceId: 'd1', telemetry }, 'fix');`)).toEqual(['indirect-logger']);
    expect(rulesOf(`${THROWN}const { error } = log;\nerror({ err }, 'failed');`)).toEqual(['indirect-logger']);
  });
});

describe('ADR-169 L1 location log guard: a logger method cannot escape by destructuring or element access', () => {
  it('every destructuring spelling of a logger method or child is refused', () => {
    const later = "\nnote({ telemetry });";
    expect(rulesOf(`const { info: note } = log;${later}`)).toEqual(['indirect-logger']);
    expect(rulesOf("const { ['warn']: note } = log;")).toEqual(['indirect-logger']);
    expect(rulesOf("const { [level]: note } = log;")).toEqual(['indirect-logger']);
    expect(rulesOf("const { child } = log;")).toEqual(['indirect-logger']);
    expect(rulesOf("const { info, warn } = this.logger;")).toEqual(['indirect-logger', 'indirect-logger']);
    expect(rulesOf("const { warn } = createChildLogger({ module: 'location' });")).toEqual(['indirect-logger']);
    expect(rulesOf("const { error } = log.child({ component: 'evaluator' });")).toEqual(['indirect-logger']);
    expect(rulesOf("function onFix({ info } = log) { info({ telemetry }); }")).toEqual(['indirect-logger']);
    expect(rulesOf("function onFix({ error }: Logger) { error({ err }); }")).toEqual(['indirect-logger']);
    expect(rulesOf("function register({ log: { error } }: Deps) { error({ err }); }")).toEqual(['indirect-logger']);
    expect(rulesOf("let info: unknown;\n({ info } = log);")).toEqual(['indirect-logger']);
    // A rest binding keeps the methods on an object, so rest.info(...) is still checked as a log call.
    expect(rulesOf(`${TELEMETRY}const { ...rest } = log;\nrest.info({ telemetry });`)).toEqual(['key-not-allowlisted']);
  });

  it('element access on a logger is held to the same rules as dot access', () => {
    expect(rulesOf(`${TELEMETRY}log[level]({ deviceId: 'd1', telemetry }, 'fix');`)).toEqual(['key-not-allowlisted']);
    expect(rulesOf(`${THROWN}log[level]({ err }, 'failed');`)).toEqual(['error-object']);
    expect(rulesOf("const note = log['warn'];")).toEqual(['indirect-logger']);
    expect(rulesOf("const note = log[level];")).toEqual(['indirect-logger']);
    expect(rulesOf("log['info'].call(log, { lat: 1 });")).toEqual(['indirect-logger']);
    expect(rulesOf("fetchFix().catch(createChildLogger({ module: 'location' }).error);")).toEqual(['indirect-logger']);
  });
});

describe('ADR-169 L1 location log guard: accepted forms and reporting', () => {
  it('ids, counts, literal labels, a scalar message and locationSafeError pass', () => {
    const body = [
      "const startedAt = Date.now();",
      "log.info({ ruleId: rule.id, fireId, placeCount: places.length, durationMs: Date.now() - startedAt, outcome: 'fired' }, 'rule fired');",
      "try { run(); } catch (error) { log.error({ err: locationSafeError(error), ruleId }, 'dispatch failed'); }",
      "log.debug(`claimed ${claimedCount} fires for rule ${rule.id}`);",
      "log.warn({ reason: stale ? 'stale-fix' : 'low-accuracy', deviceId: device.id, total: rows.length ?? 0 }, 'fix ignored');",
      "const child = log.child({ component: 'evaluator' });",
      "child.trace('tick');",
      "log.info();",
    ].join('\n');
    expect(rulesOf(body)).toEqual([]);
    const aliased = "import { createChildLogger, locationSafeError as safeError } from '@/shared/logger';\nconst log = createChildLogger({ module: 'location' });\n";
    expect(rulesOf("try { run(); } catch (e) { log.error({ err: safeError(e) }, 'failed'); }", aliased)).toEqual([]);
  });

  it('destructuring things that are not logger methods passes', () => {
    const body = [
      "const { info, warn } = strings;",
      "const { deviceId } = req.params;",
      "const { logger } = deps;",
      "logger.info({ deviceId }, 'fix received');",
      "function onFix({ ruleId }: FireRow) { log.info({ ruleId }); }",
      "try { run(); } catch ({ message }) { log.warn({ reason: 'lookup-failed' }); }",
    ].join('\n');
    expect(rulesOf(body)).toEqual([]);
  });

  it('reports the file and line of each violation', () => {
    const [violation] = scanLocationLogSource('src/app/routes/location-routes.ts', `${HEADER}\n\nlog.info({ telemetry });\n`);
    expect(violation).toMatchObject({ file: 'src/app/routes/location-routes.ts', line: 5, rule: 'key-not-allowlisted' });
  });
});

/** Write one file into a scratch tree, creating its directories. */
function plant(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/**
 * The server.ts of the scratch tree: mounts through a local const, a barrel, shared middleware and
 * a path const imported from a paths module (a location one, and a tickets one that stays out).
 */
const SCRATCH_SERVER = [
  HEADER,
  "import { createOwnerGeoRoutes } from './routes/owner-geo-routes';",
  "import { createPlaceRoutes, createUnrelatedRoutes } from './routes';",
  "import { createPresenceRoutes } from './routes/presence-routes';",
  "import { GEO_API_BASE, TICKETS_API_BASE } from './routes/route-paths';",
  "import { rateLimit } from '@/shared/middleware/rate-limit';",
  "declare const app: any; declare const requiresAuth: any; declare const mysteryRouter: any;",
  "log.info({ unrelated: true }, 'server boot');",
  "const geoRouter = createOwnerGeoRoutes({});",
  "app.use('/api/location/mine', requiresAuth, rateLimit(), geoRouter);",
  "app.use('/api/location/places', requiresAuth, createPlaceRoutes({}));",
  "app.use(GEO_API_BASE, requiresAuth, createPresenceRoutes({}));",
  "app.get('/api/location/debug', (_req: any, res: any) => res.json({}));",
  "app.use('/api/location/lost', requiresAuth, mysteryRouter);",
  "app.use(TICKETS_API_BASE, requiresAuth, createUnrelatedRoutes());",
  '',
].join('\n');

/** A logger header for route files that never mention the word location themselves. */
const DEVICES_HEADER = "import { createChildLogger } from '@/shared/logger';\nconst log = createChildLogger({ module: 'devices' });\n";

/**
 * Route paths held in consts imported from paths modules: a local `export { X as Y }` list, and a
 * shared barrel that renames a const composed from further consts. The files that USE them say
 * nothing about location, so only following the import can put them in scope.
 */
function plantPathModules(root: string): void {
  plant(root, 'src/app/routes/route-paths.ts', "const GEO = '/api/location/presence';\nexport { GEO as GEO_API_BASE };\nexport const TICKETS_API_BASE = '/api/tickets';\n");
  plant(root, 'src/shared/api-paths/index.ts', "export { FIX_ROUTE as DEVICE_FIX_PATH } from './geo-paths';\n");
  plant(root, 'src/shared/api-paths/geo-paths.ts', "const API = '/api';\nconst GEO = `${API}/location`;\nexport const FIX_ROUTE = GEO + '/devices/:deviceId/fix';\n");
}

/** Route files whose /api/location path is an imported const (named, namespace) or a function-local const. */
function plantConstPathRoutes(root: string, leak: boolean): void {
  const value = (bad: string, good: string): string => (leak ? bad : good);
  plant(root, 'src/app/routes/presence-routes.ts', `${HEADER}export function createPresenceRoutes(r: any) { r.post('/', (req: any) => log.info(${value('{ telemetry: req.body }', "{ deviceId: 'd1' }")}, 'presence')); return r; }\n`);
  plant(root, 'src/app/routes/device-fix-routes.ts', `${DEVICES_HEADER}import { DEVICE_FIX_PATH } from '@/shared/api-paths';\nexport function registerDeviceFix(router: any) { router.post(DEVICE_FIX_PATH, (req: any) => log.info(${value('{ fix: req.body }', '{ deviceId: req.params.deviceId }')}, 'fix')); }\n`);
  plant(root, 'src/app/routes/device-ping-routes.ts', `${DEVICES_HEADER}import * as apiPaths from '@/shared/api-paths';\nexport function registerDevicePing(router: any) { router.get(apiPaths.DEVICE_FIX_PATH + '/ping', (req: any) => log.info(${value('{ ping: req.query }', "{ deviceId: 'd1' }")})); }\n`);
  plant(root, 'src/app/routes/nearby-routes.ts', `${HEADER}export function registerNearby(router: any) { const NEARBY = '/api/location/nearby'; router.get(NEARBY, (req: any) => log.info(${value('{ near: req.query }', '{ placeCount: 0 }')})); }\n`);
}

/**
 * A scratch tree with the repository layout: every way location code can be wired, each with one
 * leak, plus code that must stay OUT of scope (server.ts itself, shared middleware, other routes).
 */
function plantLeakyTree(root: string): void {
  plant(root, 'src/features/location/index.ts', "export * from './services/evaluator';\n");
  plant(root, 'src/features/location/services/evaluator.ts', `${HEADER}export function evaluate(telemetry: unknown) { log.info({ telemetry }, 'fix received'); }\n`);
  plant(root, 'src/app/routes/location-routes.ts', `${HEADER}export function createLocationRoutes(r: any) { r.post('/presence', (req: any) => log.info({ fix: req.body }, 'presence')); return r; }\n`);
  plant(root, 'src/app/routes/presence-ingest-routes.ts', `${HEADER}export function registerPresence(app: any) { app.post('/api/location/devices/:deviceId/presence', (req: any) => { log.error(req.error); }); }\n`);
  plant(root, 'src/app/routes/current-place-routes.ts', `${HEADER}const BASE = '/api/location';\nexport function registerCurrent(router: any) { router.get(\`\${BASE}/current\`, (req: any) => log.info({ coords: req.query }, 'current')); }\n`);
  plant(root, 'src/app/routes/owner-geo-routes.ts', `${HEADER}export function createOwnerGeoRoutes(r: any) { r.get('/mine', () => log.info({ address: 'typed by owner' })); return r; }\n`);
  plant(root, 'src/app/routes/place-routes.ts', `${HEADER}export const createPlaceRoutes = (r: any) => { r.get('/', () => log.warn({ placeName: 'home' })); return r; };\n`);
  plant(root, 'src/app/routes/index.ts', "export { createPlaceRoutes } from './place-routes';\nexport * from './unrelated-routes';\n");
  plant(root, 'src/app/routes/unrelated-routes.ts', `${HEADER}export function createUnrelatedRoutes() { log.info({ anything: 1 }); }\n`);
  plant(root, 'src/shared/middleware/rate-limit.ts', `${HEADER}export function rateLimit() { log.info({ anything: 1 }); return () => undefined; }\n`);
  plant(root, 'src/app/server.ts', SCRATCH_SERVER);
  plantPathModules(root);
  plantConstPathRoutes(root, true);
}

/** Rewrite every leak in the scratch tree to ids and counts, keeping each file's wiring. */
function rewriteClean(root: string): void {
  plant(root, 'src/features/location/services/evaluator.ts', `${HEADER}export function evaluate(deviceId: string) { log.info({ deviceId }, 'fix received'); }\n`);
  plant(root, 'src/app/routes/location-routes.ts', `${HEADER}export function createLocationRoutes(r: any) { r.post('/presence', () => log.info({ deviceId: 'd1' }, 'presence')); return r; }\n`);
  plant(root, 'src/app/routes/presence-ingest-routes.ts', `${HEADER}export function registerPresence(app: any) { app.post('/api/location/devices/:deviceId/presence', (req: any) => { log.info({ deviceId: req.params.deviceId }); }); }\n`);
  plant(root, 'src/app/routes/current-place-routes.ts', `${HEADER}const BASE = '/api/location';\nexport function registerCurrent(router: any) { router.get(\`\${BASE}/current\`, (_req: any, place: any) => log.info({ placeId: place.id }, 'current')); }\n`);
  plant(root, 'src/app/routes/owner-geo-routes.ts', `${HEADER}export function createOwnerGeoRoutes(r: any) { r.get('/mine', () => log.info({ placeCount: 2 })); return r; }\n`);
  plant(root, 'src/app/routes/place-routes.ts', `${HEADER}export const createPlaceRoutes = (r: any) => { r.get('/', () => log.warn({ placeId: 'p1' })); return r; };\n`);
  plant(root, 'src/app/server.ts', SCRATCH_SERVER
    .replace("app.get('/api/location/debug', (_req: any, res: any) => res.json({}));\n", '')
    .replace("app.use('/api/location/lost', requiresAuth, mysteryRouter);\n", ''));
  plantConstPathRoutes(root, false);
}

describe('ADR-169 L1 location log guard: scope is derived from the tree', () => {
  let scratch = '';
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-location-log-guard-'));
    plantLeakyTree(scratch);
  });
  afterAll(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });

  it('covers the slice, location-named routes, declared paths and followed mounts, and nothing else', () => {
    const result = checkLocationLogSafety(scratch);
    expect(result.files).toEqual([
      'src/app/routes/current-place-routes.ts',
      'src/app/routes/device-fix-routes.ts',
      'src/app/routes/device-ping-routes.ts',
      'src/app/routes/location-routes.ts',
      'src/app/routes/nearby-routes.ts',
      'src/app/routes/owner-geo-routes.ts',
      'src/app/routes/place-routes.ts',
      'src/app/routes/presence-ingest-routes.ts',
      'src/app/routes/presence-routes.ts',
      'src/features/location/index.ts',
      'src/features/location/services/evaluator.ts',
    ]);
    expect(pairs(result.violations)).toEqual([
      'src/app/routes/current-place-routes.ts key-not-allowlisted',
      'src/app/routes/device-fix-routes.ts key-not-allowlisted',
      'src/app/routes/device-ping-routes.ts key-not-allowlisted',
      'src/app/routes/location-routes.ts key-not-allowlisted',
      'src/app/routes/nearby-routes.ts key-not-allowlisted',
      'src/app/routes/owner-geo-routes.ts key-not-allowlisted',
      'src/app/routes/place-routes.ts key-not-allowlisted',
      'src/app/routes/presence-ingest-routes.ts merge-object-not-inline',
      'src/app/routes/presence-routes.ts key-not-allowlisted',
      'src/app/server.ts mount-unresolved',
      'src/app/server.ts route-outside-routes',
      'src/features/location/services/evaluator.ts key-not-allowlisted',
    ]);
  });

  it('goes green once every planted leak is rewritten to ids and counts, with the same scope', () => {
    rewriteClean(scratch);
    const result = checkLocationLogSafety(scratch);
    expect(result.violations).toEqual([]);
    expect(result.files).toHaveLength(11);
  });
});

describe('ADR-169 L1 location log guard: route paths held in imported consts', () => {
  let scratch = '';
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-location-log-guard-paths-'));
    plantLeakyTree(scratch);
  });
  afterAll(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });

  it('follows a /api/location path held in an imported const, on a mount and on a declaration', () => {
    const { files } = checkLocationLogSafety(scratch);
    // server.ts: app.use(GEO_API_BASE, …) with GEO_API_BASE from a local `export { GEO as … }` list.
    expect(files).toContain('src/app/routes/presence-routes.ts');
    // router.post(DEVICE_FIX_PATH, …) / apiPaths.DEVICE_FIX_PATH through a renaming '@/' barrel.
    expect(files).toEqual(expect.arrayContaining(['src/app/routes/device-fix-routes.ts', 'src/app/routes/device-ping-routes.ts']));
    for (const rel of ['src/app/routes/device-fix-routes.ts', 'src/app/routes/device-ping-routes.ts']) {
      expect(fs.readFileSync(path.join(scratch, rel), 'utf8'), rel).not.toMatch(/location/i);
    }
    // The paths modules themselves, and the tickets mount through an imported const, stay out.
    expect(files).not.toContain('src/app/routes/route-paths.ts');
    expect(files).not.toContain('src/app/routes/unrelated-routes.ts');
    expect(files.some((f) => f.startsWith('src/shared/'))).toBe(false);
  });
});
