/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for ADR-169 slice L1 (shared geo maths, namespaced location redaction, static log guard). Two credential-free, in-process steps against the build that is running: the shipped pino redact config censors a synthetic fix under location/coords at top level and one level down and the locationSafeError projection of a URL-bearing error carries no URL or coordinate; and the shared geo maths answers a synthetic containment, rounding and band canary. Neither step reads, stores or logs anyone's location. The static guard itself runs in the unit suite (regressionTests), not at runtime.
 */

import pino from 'pino';
import { LOG_REDACT_OPTIONS, locationSafeError } from '@/shared/logger';
import { circleContains, distanceBand, haversineM, minimiseGeoPoint, type GeoPoint } from '@/shared/utils/geo';
import type { Scenario, StepResult } from './test-lab-scenarios';

const APP = 'location';
const REDACTION_LABEL = 'Location never reaches a log line (ADR-169 L1)';
const GEO_LABEL = 'Shared geo maths on this build (ADR-169 L1)';
/** The namespaced keys ADR-169 D3 adds to the platform-wide redact list. */
export const LOCATION_REDACT_KEYS: readonly string[] = ['location', '*.location', 'coords', '*.coords'];
/** Synthetic values in the open South Atlantic: no address, no person. */
const SYNTHETIC_LAT = -12.34567;
const SYNTHETIC_LON = -31.98765;
const SYNTHETIC_URL = `https://geo.example/reverse?lat=${SYNTHETIC_LAT}&lon=${SYNTHETIC_LON}`;
const NOT_LIVE = 'In-process check of this build; it reads and logs nobody\'s location.';

/** What the redaction step grades: the redact config and the error projection, injectable for tests. */
export interface LocationRedactionInput {
  redact: { paths: readonly string[]; censor: string };
  safeError: (error: unknown) => unknown;
}

/**
 * @description Serialise one synthetic fix through a real pino logger over a redact config.
 * @param redact - The redact config under test.
 * @returns The serialised log output.
 */
function serialiseSyntheticFix(redact: LocationRedactionInput['redact']): string {
  let buffer = '';
  const destination = { write(chunk: string): void { buffer += chunk; } };
  const log = pino({ level: 'info', redact: { paths: [...redact.paths], censor: redact.censor }, base: undefined },
    destination as pino.DestinationStream);
  log.info({ location: { lat: SYNTHETIC_LAT, lon: SYNTHETIC_LON }, coords: [SYNTHETIC_LAT, SYNTHETIC_LON] }, 'top');
  log.info({ device: { location: String(SYNTHETIC_LAT), coords: String(SYNTHETIC_LON) } }, 'nested');
  return buffer;
}

/**
 * @description Grade the log-redaction half of L1 on a given config and error projection.
 * @param input - The redact config and the safe-error function.
 * @returns The Lab step result: fail names the missing key or the leaked value.
 */
export function locationRedactionStep(input: LocationRedactionInput): StepResult {
  const result = (state: StepResult['state'], detail: string, output?: unknown): StepResult =>
    ({ app: APP, label: REDACTION_LABEL, state, detail, ...(output === undefined ? {} : { output }) });
  const missing = LOCATION_REDACT_KEYS.filter((key) => !input.redact.paths.includes(key));
  if (missing.length) return result('fail', `The redact list on this build lacks ${missing.join(', ')}.`, { missing });
  const logged = serialiseSyntheticFix(input.redact);
  const leakedFix = [String(SYNTHETIC_LAT), String(SYNTHETIC_LON)].filter((v) => logged.includes(v));
  if (leakedFix.length) return result('fail', 'A synthetic fix under location/coords reached the serialised log line.', { leakedFix });
  const projected = JSON.stringify(input.safeError(new TypeError(`GET ${SYNTHETIC_URL} failed`)));
  const leakedError = ['geo.example', String(SYNTHETIC_LAT), String(SYNTHETIC_LON)].filter((v) => projected.includes(v));
  if (leakedError.length) return result('fail', 'The location error projection kept the URL or a coordinate.', { leakedError });
  return result('pass', `Redact keys ${LOCATION_REDACT_KEYS.join(', ')} censor a synthetic fix at top level and one level down; the error projection keeps no URL. ${NOT_LIVE}`);
}

/**
 * @description The shared geo canary: containment at a 100 m place, block rounding and a band,
 * all on synthetic points with known answers.
 * @returns The Lab step result.
 */
export function locationGeoStep(): StepResult {
  const centre: GeoPoint = { lat: SYNTHETIC_LAT, lon: SYNTHETIC_LON };
  const metresPerDegree = (6_371_000 * Math.PI) / 180;
  const northBy = (m: number): GeoPoint => ({ lat: centre.lat + m / metresPerDegree, lon: centre.lon });
  const place = { center: centre, radiusM: 100 };
  const checks: Array<[string, boolean]> = [
    ['one degree of latitude is 111.19 km', Math.abs(haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - metresPerDegree) < 0.001],
    ['99 m north is inside a 100 m place', circleContains(place, northBy(99))],
    ['101 m north is outside it', !circleContains(place, northBy(101))],
    ['block keeps 3 decimals', JSON.stringify(minimiseGeoPoint(centre, 'block')) === '{"lat":-12.346,"lon":-31.988}'],
    ['place-only keeps no coordinates', minimiseGeoPoint(centre, 'place-only') === null],
    ['600 m beyond the edge is <1 km', distanceBand(northBy(700), place) === '<1 km'],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  const base = { app: APP, label: GEO_LABEL };
  if (failed.length) return { ...base, state: 'fail', detail: `Geo canary failed: ${failed.join('; ')}.`, output: { failed } };
  return { ...base, state: 'pass', detail: `${checks.length} synthetic geo checks pass (haversine, containment, block rounding, place-only, distance band). ${NOT_LIVE}` };
}

/** The ADR-169 L1 Test Lab card: two in-process, credential-free steps. */
export const LOCATION_SCENARIOS: Scenario[] = [{
  id: 'location-log-safety',
  title: 'Location — logs never carry a position (ADR-169 L1)',
  group: 'tool',
  description: 'Checks the running build carries ADR-169 slice L1: the platform log redaction censors a synthetic fix under the namespaced location and coords keys, the one error shape location code may log keeps no URL or coordinate, and the shared geo maths (haversine, place containment, precision rounding, distance bands) answers a synthetic canary. The static log guard over src/features/location and the location routes runs in the unit suite linked below. In-process and credential-free: it reads, stores and logs nobody\'s location.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/location-log-guard.spec.ts' },
    { level: 'unit', path: 'tests/unit/shared-geo.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-safe-error.spec.ts' },
    { level: 'unit', path: 'tests/unit/logger-redaction.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-location-registration.spec.ts' },
  ],
  steps: [
    { id: 'log-redaction', app: APP, label: REDACTION_LABEL,
      run: async () => locationRedactionStep({ redact: LOG_REDACT_OPTIONS, safeError: locationSafeError }) },
    { id: 'geo-canary', app: APP, label: GEO_LABEL, run: async () => locationGeoStep() },
  ],
}];
