/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for ADR-169 slice L7 (map anchors and the ADR-111 amendment). Two steps on the running build. The posture step reads only the catalog: spatial_scans carries tenant_id and capture_session_id, its group fence is installed as a RESTRICTIVE policy beside the member policy and neither mentions the operator flag, and the owner fence and the scan-removal trigger are installed. The lifecycle step, for three uniquely tagged synthetic people on the real database and the real scans root: an admin makes a group with a member and a group place; two group scans are registered through the real scan store, each naming a guided-capture session whose telemetry was written to the capturer's sidecar, one captured inside the place and one outside every saved place; the real service joins each session's GPS to its scan and the real anchorMap records it; on a later visit the member gets both from mapsNear, newest first and by reference, and opens a group scan; a stranger, operator-stamped or not, gets nothing from mapsNear and reads neither scan; a member who is not an admin cannot anchor a group's map. Everything created is deleted (the scans and with them their anchors, the sidecars, the place, the group with its memberships) and a zero-row check runs; incomplete cleanup is a failure. No real person's location is read or written and no position is ever logged.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { anchorMap, mapsNear, withLocationOwnerSession, type LocationMapAnchorResult, type LocationPrincipal } from '@/features/location';
import { SpatialMappingService, SpatialScanStore, captureTelemetryPath, resolveScansRoot, subHash } from '@/features/spatial-mapping';
import { createChildLogger, locationSafeError } from '@/shared/logger';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { createLocationPlace, deleteLocationPlace, parsePlaceInput } from '../location-places';
import { addMember, createTenant } from './connector-tenancy';
import type { Scenario, ScenarioRunContext, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-location-map' });
const APP = 'location';
const POSTURE_LABEL = 'A group\'s scans are fenced to its members on this database (ADR-169 L7)';
const LIFECYCLE_LABEL = 'Two captured maps are found on a later visit by synthetic people (ADR-169 L7)';
const PROBE_ISSUER = 'urn:oshal:test-lab';
const FIELD = { lat: -12.37, lon: -31.95 };
const FAR_FIELD = { lat: -12.325, lon: -31.95 };
const BETWEEN = { lat: -12.3475, lon: -31.95 };
const COORDINATE_KEYS = /"(lat|lon|latitude|longitude|center|origin_lat|origin_lon|distance)"/;
const GROUP_POLICIES = ['spatial_scans_tenant_fence', 'spatial_scans_tenant_member'];
const SCAN_TRIGGERS = ['location_map_anchor_scan_removed', 'spatial_scans_owner_fence'];

type Pool = ScenarioRunContext['ctx']['pool'];
type Check = [string, boolean];
type Result = (state: StepResult['state'], detail: string, output?: unknown) => StepResult;
const resultFor = (label: string): Result => (state, detail, output) =>
  ({ app: APP, label, state, detail, ...(output === undefined ? {} : { output }) });

/** @description What the catalog says about the ADR-111 amendment on one database. */
export interface MapPosture {
  /** The amendment's columns present on spatial_scans. */
  columns: string[];
  /** The group policies present, with whether each is permissive and whether its text names the operator flag. */
  policies: Array<{ name: string; permissive: boolean; namesOperator: boolean }>;
  /** The triggers present on spatial_scans. */
  triggers: string[];
}

/**
 * @description Read the amendment's posture from the catalog. Catalog reads only.
 * @param pool - The running server's pool.
 * @returns The columns, group policies and triggers found.
 */
export async function readMapPosture(pool: Pool): Promise<MapPosture> {
  const columns = (await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'spatial_scans' AND column_name = ANY($1::text[]) ORDER BY column_name`,
  [['capture_session_id', 'tenant_id']])).rows.map((r: { column_name: string }) => String(r.column_name));
  const policies = (await pool.query(`SELECT policyname, permissive, COALESCE(qual, '') || ' ' || COALESCE(with_check, '') AS body
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'spatial_scans' AND policyname = ANY($1::text[]) ORDER BY policyname`,
  [GROUP_POLICIES])).rows.map((r: { policyname: string; permissive: string; body: string }) =>
    ({ name: String(r.policyname), permissive: String(r.permissive).toUpperCase() === 'PERMISSIVE', namesOperator: String(r.body).includes('is_operator') }));
  const triggers = (await pool.query(`SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relname = 'spatial_scans' AND t.tgname = ANY($1::text[]) ORDER BY t.tgname`,
  [SCAN_TRIGGERS])).rows.map((r: { tgname: string }) => String(r.tgname));
  return { columns, policies, triggers };
}

/**
 * @description Grade a posture read.
 * @param posture - The catalog read.
 * @returns The Lab step result.
 */
export function gradeMapPosture(posture: MapPosture): StepResult {
  const result = resultFor(POSTURE_LABEL);
  if (posture.columns.length !== 2) return result('fail', 'spatial_scans lacks tenant_id or capture_session_id; migration 179 is not applied.', posture);
  const fence = posture.policies.find((p) => p.name === 'spatial_scans_tenant_fence');
  const member = posture.policies.find((p) => p.name === 'spatial_scans_tenant_member');
  if (!fence || !member) return result('fail', 'The group fence or the member policy is missing on spatial_scans.', posture);
  if (fence.permissive) return result('fail', 'The group fence is permissive, so the owner policy can still admit a group\'s scan.', posture);
  if (fence.namesOperator || member.namesOperator) return result('fail', 'A group policy on spatial_scans names the operator flag.', posture);
  const missing = SCAN_TRIGGERS.filter((t) => !posture.triggers.includes(t));
  if (missing.length) return result('fail', `Triggers missing on spatial_scans: ${missing.join(', ')}.`, posture);
  return result('pass', 'spatial_scans carries its group and capture session, the group fence is restrictive beside the member policy with no operator branch, and the owner fence and scan-removal trigger are installed. Catalog reads only.');
}

/** The synthetic people and what the lifecycle created, for the cleanup. */
interface LabWorld {
  admin: LocationPrincipal;
  member: LocationPrincipal;
  stranger: LocationPrincipal;
  tag: string;
  groupId: string;
  placeId: string;
  scans: string[];
}

/** Run `fn` with the ambient identity of one synthetic person. */
const as = <T>(who: LocationPrincipal, fn: () => Promise<T>, operator = false): Promise<T> =>
  runWithRequestIdentity({ sub: who.sub, principalIssuer: who.principalIssuer, isOperator: operator }, fn);

/** Register a group scan the way a capture does: the session's telemetry, then the row naming the session. */
async function capture(pool: Pool, w: LabWorld, at: { lat: number; lon: number }, title: string, whenMs: number): Promise<string> {
  const id = randomUUID();
  const sessionId = randomUUID();
  const file = captureTelemetryPath(w.admin.sub, sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ sessionId, step: 0, ts: whenMs, headingDeg: 15, sweepDeg: 0, steps: 0, gps: { ...at, accuracyM: 7 } })}\n`);
  w.scans.push(id);
  await as(w.admin, () => new SpatialScanStore(pool).insert({
    id, userSub: w.admin.sub, title, sourceKind: 'model', sourceName: 'test-lab.ply', sourceRef: '', sourceBytes: 0,
    tenantId: w.groupId, captureSessionId: sessionId,
  }));
  return id;
}

/** Anchor a scan from its joined capture GPS, as the given person. */
async function anchor(pool: Pool, who: LocationPrincipal, owner: LocationPrincipal, scanId: string, groupId: string): Promise<LocationMapAnchorResult> {
  const joined = await as(owner, () => new SpatialMappingService(pool).captureAnchorForScan(owner.sub, scanId));
  if (!joined) throw new Error('the scan has no joined capture GPS');
  return as(who, () => anchorMap(pool, {
    mapKind: 'spatial-scan', mapRef: scanId, groupId, source: 'capture-gps', capturedAt: joined.capturedAt,
    anchor: { lat: joined.lat, lon: joined.lon, headingDeg: joined.headingDeg, accuracyM: joined.accuracyM },
    footprintRadiusM: joined.footprintRadiusM,
  }));
}

/** The group, its place and the two captured scans, recorded on the world as they are made. */
async function buildWorld(pool: Pool, w: LabWorld): Promise<{ inside: string; outside: string }> {
  w.groupId = (await as(w.admin, () => createTenant(pool, { name: `Test Lab L7 ${w.tag}`, createdBySub: w.admin.sub }))).tenant_id;
  await as(w.admin, () => addMember(pool, w.groupId, w.member.sub, w.admin.sub));
  w.placeId = (await createLocationPlace(pool, w.admin, parsePlaceInput({ name: 'Test Lab field', center: FIELD, groupId: w.groupId }, 'create'))).placeId;
  const earlier = Date.now() - 7_200_000;
  const inside = await capture(pool, w, FIELD, 'Test Lab scan in the field', earlier);
  const outside = await capture(pool, w, FAR_FIELD, 'Test Lab scan elsewhere', earlier + 3_600_000);
  return { inside, outside };
}

/** How many of the scans a person reads directly, stamped as an operator or not. */
async function readable(pool: Pool, who: LocationPrincipal, scans: string[], operator: boolean): Promise<number> {
  return as(who, async () => Number((await pool.query('SELECT count(*)::int AS n FROM spatial_scans WHERE id = ANY($1::text[])', [scans])).rows[0].n), operator);
}

/** The anchors, the later visit and the refusals over the world the step built. */
async function lifecycleChecks(pool: Pool, w: LabWorld, scans: { inside: string; outside: string }): Promise<Check[]> {
  const inside = await anchor(pool, w.admin, w.admin, scans.inside, w.groupId);
  const outside = await anchor(pool, w.admin, w.admin, scans.outside, w.groupId);
  const visit = await as(w.member, () => mapsNear(pool, BETWEEN, 5000));
  const opened = await as(w.member, () => new SpatialMappingService(pool).getGroupScan(w.member.sub, scans.inside));
  const strangerVisit = await as(w.stranger, () => mapsNear(pool, BETWEEN, 5000));
  const stampedVisit = await as(w.stranger, () => mapsNear(pool, BETWEEN, 5000), true);
  const strangerOpened = await as(w.stranger, () => new SpatialMappingService(pool).getGroupScan(w.stranger.sub, scans.inside));
  const memberAnchors = await anchor(pool, w.member, w.admin, scans.inside, w.groupId).then(() => 'anchored', (e: Error) => e.name);
  return [
    ['the scan captured inside the group place is anchored to that place from its capture GPS', inside.placeId === w.placeId],
    ['the scan captured outside every saved place is anchored with no place', outside.placeId === null && Boolean(outside.anchorId)],
    ['the anchor replies carry no coordinate', !COORDINATE_KEYS.test(JSON.stringify([inside, outside]))],
    ['another member gets both from mapsNear on a later visit, newest first',
      visit.map((m) => m.mapRef).join() === [scans.outside, scans.inside].join() && visit[1].placeId === w.placeId],
    ['mapsNear carries no coordinate', !COORDINATE_KEYS.test(JSON.stringify(visit))],
    ['the member opens a group scan they did not capture', opened?.id === scans.inside && opened.userSub === w.admin.sub],
    ['a stranger gets nothing from mapsNear, stamped as an operator or not', strangerVisit.length === 0 && stampedVisit.length === 0],
    ['a stranger opens neither scan, stamped as an operator or not', strangerOpened === null
      && await readable(pool, w.stranger, w.scans, false) === 0 && await readable(pool, w.stranger, w.scans, true) === 0],
    ['a member who is not an admin cannot anchor a group\'s map', memberAnchors === 'LocationForbiddenError'],
  ];
}

/** Delete what the step created, then count what is left (rows and sidecar directories). */
async function cleanup(pool: Pool, w: LabWorld): Promise<number> {
  const store = new SpatialScanStore(pool);
  for (const id of w.scans) await as(w.admin, () => store.delete(w.admin.sub, id));
  if (w.placeId) await deleteLocationPlace(pool, w.admin, w.placeId);
  const sidecars = path.join(resolveScansRoot(), subHash(w.admin.sub));
  await fs.rm(sidecars, { recursive: true, force: true });
  const files = await fs.access(sidecars).then(() => 1, () => 0);
  const rows = await withLocationOwnerSession(pool, w.admin, async (client) => {
    if (w.groupId) await client.query('DELETE FROM oshal_tenants WHERE tenant_id = $1', [w.groupId]);
    const r = await client.query(`SELECT (SELECT count(*) FROM spatial_scans WHERE id = ANY($2::text[]))
      + (SELECT count(*) FROM location_map_anchors WHERE map_ref = ANY($2::text[]) OR tenant_id::text = $1)
      + (SELECT count(*) FROM location_places WHERE tenant_id::text = $1)
      + (SELECT count(*) FROM oshal_tenants WHERE tenant_id::text = $1) AS n`, [w.groupId || '', w.scans]);
    return Number(r.rows[0].n);
  });
  return rows + files;
}

/**
 * @description Two captured group maps found on a later visit, for three synthetic people on the real database, with a full cleanup and a zero-row check.
 * @param runtime - The Lab's server-derived context.
 * @returns The Lab step result.
 */
export async function mapLifecycleStep(runtime?: ScenarioRunContext): Promise<StepResult> {
  const result = resultFor(LIFECYCLE_LABEL);
  if (!runtime?.ctx?.pool) return result('gap', 'Needs the running server\'s database pool; run it from the Test Lab.');
  const tag = randomUUID();
  const person = (role: string): LocationPrincipal => ({ sub: `test-lab-location-l7-${role}-${tag}`, principalIssuer: PROBE_ISSUER });
  const w: LabWorld = { admin: person('admin'), member: person('member'), stranger: person('stranger'), tag, groupId: '', placeId: '', scans: [] };
  let checks: Check[] = [];
  let failure = '';
  try {
    checks = await lifecycleChecks(runtime.ctx.pool, w, await buildWorld(runtime.ctx.pool, w));
  } catch (error) {
    logger.error({ op: 'lab-lifecycle', outcome: 'failed', err: locationSafeError(error) }, 'Test Lab location map lifecycle could not run');
    failure = `The lifecycle could not run: ${(error as { code?: string }).code ?? (error as Error).name}.`;
  }
  let left = -1;
  try {
    left = await cleanup(runtime.ctx.pool, w);
  } catch (error) {
    logger.error({ op: 'lab-cleanup', outcome: 'failed', err: locationSafeError(error) }, 'Test Lab location map cleanup failed');
  }
  if (left !== 0) return result('fail', `${failure} Cleanup incomplete: ${left < 0 ? 'the cleanup failed' : `${left} synthetic rows or files remain`}.`.trim());
  if (failure) return result('fail', `${failure} Synthetic rows were deleted.`);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) return result('fail', `Lifecycle failed: ${failed.join('; ')}. Synthetic rows were deleted.`, { failed });
  return result('pass', `${checks.length} checks hold: ${checks.map(([name]) => name).join('; ')}. The scans with their anchors, the capture sidecars, the place and the group were deleted and nothing of theirs remains.`);
}

/** The ADR-169 L7 Test Lab card. */
export const LOCATION_MAP_SCENARIOS: Scenario[] = [{
  id: 'location-map-anchors',
  title: 'Location — a map is found again where it was captured (ADR-169 L7)',
  group: 'tool',
  description: 'Checks ADR-169 slice L7 on the running build. First the catalog: spatial_scans carries its group and capture session, the group fence is a restrictive policy beside the member policy with no operator branch, and the owner fence and scan-removal trigger are installed. Then three uniquely tagged synthetic people on the real database: an admin makes a group with a member and a group place and registers two group scans, each naming a guided-capture session, one captured inside the place and one outside every saved place; each scan is anchored from the GPS its own session recorded; on a later visit the member gets both from mapsNear, newest first and by reference, and opens a group scan; a stranger, operator-stamped or not, gets nothing and reads neither scan; a member who is not an admin cannot anchor a group\'s map. Everything created is deleted and a zero-row check runs. No real person\'s location is read or written.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/location-map-anchors-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/spatial-group-scans-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/spatial-capture-anchor.spec.ts' },
    { level: 'unit', path: 'tests/unit/spatial-mapping-store.spec.ts' },
    { level: 'unit', path: 'tests/unit/shared-geo.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-rls-no-operator-guard.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-log-guard.spec.ts' },
    { level: 'integration', path: 'tests/unit/provisioner-migrated-helpers-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/test-lab-location-map-registration.spec.ts' },
  ],
  steps: [
    { id: 'map-posture', app: APP, label: POSTURE_LABEL, run: async (_cookie, _prior, runtime) => {
      if (!runtime?.ctx?.pool) return resultFor(POSTURE_LABEL)('gap', 'Needs the running server\'s database pool; run it from the Test Lab.');
      return gradeMapPosture(await readMapPosture(runtime.ctx.pool));
    } },
    { id: 'map-lifecycle', app: APP, label: LIFECYCLE_LABEL, run: async (_cookie, _prior, runtime) => mapLifecycleStep(runtime) },
  ],
}];
