/**
 * Sunrise / sunset computation (NOAA sunrise equation) for solar smart-home
 * schedules ("porch lights at dusk"). Pure function, no deps — given a location
 * and a date, returns the UTC instant of the sun event so a schedule can fire
 * at the right local moment, which shifts a couple minutes every day.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — sunEventUtc(lat,lng,date,event) via the standard sunrise equation; powers solar (sunrise/sunset ± offset) home schedules, recomputed daily by the home solar replanner.
 *
 * @module sun-times
 */

/** Which solar event a schedule is anchored to. */
export type SunEvent = 'sunrise' | 'sunset';

const RAD = Math.PI / 180;
const ZENITH = 90.833; // official sunrise/sunset (includes atmospheric refraction + sun radius)

/** Day of year (1-366) for a date, in UTC. */
function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((today - start) / 86_400_000);
}

const norm360 = (v: number): number => ((v % 360) + 360) % 360;
const norm24 = (v: number): number => ((v % 24) + 24) % 24;

/**
 * @description Compute the UTC instant of sunrise or sunset at a location on a date.
 * @param lat - latitude in decimal degrees (north positive)
 * @param lng - longitude in decimal degrees (east positive)
 * @param date - the calendar day (UTC y/m/d is used)
 * @param event - 'sunrise' | 'sunset'
 * @returns a Date at the event (UTC), or null at polar latitudes where the sun
 *          does not rise/set that day.
 */
export function sunEventUtc(lat: number, lng: number, date: Date, event: SunEvent): Date | null {
  const N = dayOfYear(date);
  const lngHour = lng / 15;
  const t = event === 'sunrise' ? N + (6 - lngHour) / 24 : N + (18 - lngHour) / 24;

  // Sun's mean anomaly → true longitude.
  const M = 0.9856 * t - 3.289;
  const L = norm360(M + 1.916 * Math.sin(M * RAD) + 0.020 * Math.sin(2 * M * RAD) + 282.634);

  // Right ascension, put in the same quadrant as L, then to hours.
  let RA = norm360(Math.atan(0.91764 * Math.tan(L * RAD)) / RAD);
  RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90;
  RA /= 15;

  // Declination.
  const sinDec = 0.39782 * Math.sin(L * RAD);
  const cosDec = Math.cos(Math.asin(sinDec));

  // Local hour angle.
  const cosH = (Math.cos(ZENITH * RAD) - sinDec * Math.sin(lat * RAD)) / (cosDec * Math.cos(lat * RAD));
  if (cosH > 1 || cosH < -1) return null; // sun never rises / never sets that day

  const H = (event === 'sunrise' ? 360 - Math.acos(cosH) / RAD : Math.acos(cosH) / RAD) / 15;
  const meanTime = H + RA - 0.06571 * t - 6.622;
  const ut = norm24(meanTime - lngHour);

  const hours = Math.floor(ut);
  const minutes = Math.floor((ut - hours) * 60);
  const seconds = Math.floor((((ut - hours) * 60) - minutes) * 60);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hours, minutes, seconds));
}

/**
 * @description The next future occurrence of a sun event (± offset minutes) at a
 * location, scanning forward from `from` up to a few days (handles "already past
 * today" by rolling to tomorrow, and polar gaps).
 * @returns a future Date, or null if none within the search window.
 */
export function nextSunEvent(lat: number, lng: number, event: SunEvent, offsetMinutes: number, from: Date): Date | null {
  for (let i = 0; i < 4; i++) {
    const day = new Date(from.getTime() + i * 86_400_000);
    const base = sunEventUtc(lat, lng, day, event);
    if (!base) continue;
    const at = new Date(base.getTime() + offsetMinutes * 60_000);
    if (at.getTime() > from.getTime()) return at;
  }
  return null;
}
