/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | pure TLE parser/validator. Validation is independent
 *                     |                             | of satellite.js so a malformed TLE never reaches the
 *                     |                             | propagator: size cap first, then line shape, mod-10
 *                     |                             | checksums, and satnum cross-check between lines.
 */

/** Total input size cap, enforced BEFORE any per-line work (CPU/abuse bound). */
export const TLE_MAX_CHARS = 512;

/** @description Thrown on any TLE validation failure — the route maps it to HTTP 400. */
export class TleParseError extends Error {}

/** @description A validated two-line element set ready for satellite.js. */
export interface ParsedTle {
  name: string | null;
  line1: string;
  line2: string;
  satnum: number;
  eccentricity: number;
  meanMotionRevPerDay: number;
}

/**
 * @description The standard TLE mod-10 checksum over columns 1–68: digits count their value,
 * '-' counts 1, everything else 0. Exported so the spec can cross-verify against an
 * independent implementation.
 * @param line - One 69-char TLE line (only the first 68 chars are summed).
 * @returns The checksum digit 0–9.
 */
export function tleChecksum(line: string): number {
  let sum = 0;
  for (let i = 0; i < 68 && i < line.length; i++) {
    const c = line[i];
    if (c >= '0' && c <= '9') sum += c.charCodeAt(0) - 48;
    else if (c === '-') sum += 1;
  }
  return sum % 10;
}

/** Validate one data line's shape + checksum; returns the trimmed-right line. */
function validateLine(raw: string, lineNo: 1 | 2): string {
  const line = raw.replace(/[\r\s]+$/, '');
  if (line.length !== 69) {
    throw new TleParseError(`TLE line ${lineNo} must be exactly 69 characters, got ${line.length}`);
  }
  if (!line.startsWith(`${lineNo} `)) {
    throw new TleParseError(`TLE line ${lineNo} must start with "${lineNo} "`);
  }
  const expect = Number(line[68]);
  const got = tleChecksum(line);
  if (!Number.isInteger(expect) || got !== expect) {
    throw new TleParseError(`TLE line ${lineNo} checksum mismatch: computed ${got}, line says "${line[68]}"`);
  }
  return line;
}

/**
 * @description Parse and validate a 2-line or 3-line TLE (Celestrak 3LE '0 '-name prefix
 * tolerated). Enforces the total size cap, per-line shape, mod-10 checksums, and that both
 * data lines agree on the satellite number.
 * @param raw - The TLE text, 2 or 3 lines, any of \n / \r\n endings, trailing spaces tolerated.
 * @returns The validated element set with the fields downstream checks need.
 */
export function parseTle(raw: string): ParsedTle {
  if (typeof raw !== 'string' || raw.length === 0) throw new TleParseError('TLE text is required');
  if (raw.length > TLE_MAX_CHARS) {
    throw new TleParseError(`TLE text exceeds ${TLE_MAX_CHARS} characters (${raw.length})`);
  }
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/[\r\s]+$/, '')).filter((l) => l.length > 0);
  if (lines.length !== 2 && lines.length !== 3) {
    throw new TleParseError(`expected 2 or 3 TLE lines, got ${lines.length}`);
  }
  let name: string | null = null;
  if (lines.length === 3) {
    const rawName = lines[0].startsWith('0 ') ? lines[0].slice(2) : lines[0];
    if (rawName.length > 69) throw new TleParseError('TLE name line exceeds 69 characters');
    if (rawName.startsWith('1 ') || rawName.startsWith('2 ')) {
      throw new TleParseError('first of three lines looks like a data line, not a name');
    }
    name = rawName.trim() || null;
  }
  const line1 = validateLine(lines[lines.length - 2], 1);
  const line2 = validateLine(lines[lines.length - 1], 2);
  const sat1 = line1.slice(2, 7).trim();
  const sat2 = line2.slice(2, 7).trim();
  if (sat1 !== sat2) throw new TleParseError(`satellite number mismatch between lines: "${sat1}" vs "${sat2}"`);
  const satnum = Number(sat1);
  if (!Number.isInteger(satnum)) throw new TleParseError(`unparseable satellite number "${sat1}"`);
  const eccentricity = Number(`0.${line2.slice(26, 33).trim()}`);
  const meanMotionRevPerDay = Number(line2.slice(52, 63).trim());
  if (!Number.isFinite(eccentricity) || !Number.isFinite(meanMotionRevPerDay) || meanMotionRevPerDay <= 0) {
    throw new TleParseError('unparseable eccentricity or mean motion in line 2');
  }
  return { name, line1, line2, satnum, eccentricity, meanMotionRevPerDay };
}
