/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W3:
 *                     |                             | in-memory TLE catalog. Orbit identity is deliberately
 *                     |                             | DECOUPLED from the attitude nodes (a fleet sat may
 *                     |                             | heartbeat without an element set and vice versa); the
 *                     |                             | surface joins the two views by satId. In-memory is the
 *                     |                             | W3 contract — a sim fleet's catalog is operator-loaded
 *                     |                             | per session, like the fleet registry itself.
 */

import type { TleCatalogEntry } from '../model/orbit-types';
import type { ScreenEntry } from './conjunction-screen';
import { SAT_ID_RE } from './sat-fleet';
import { parseTle, TLE_MAX_CHARS, type ParsedTle } from './tle-parse';

/** @description Thrown on invalid catalog input — HTTP 400 at the route. */
export class CatalogError extends Error {}

/** Internal row: the public entry plus the parsed element set. */
interface CatalogRow extends TleCatalogEntry {
  tle: ParsedTle;
}

/**
 * @description In-memory satId → TLE registry for the fleet plane: feeds the 3D console's
 * orbit tracks, the ground-track map, and conjunction screening. Validation happens at
 * upsert (parseTle), so every stored row is propagatable.
 */
export class TleCatalog {
  private readonly rows = new Map<string, CatalogRow>();

  /**
   * @description Insert or replace a catalog row after validating the element set.
   * @param satId - Fleet sat id (joins to heartbeat telemetry when the ids match).
   * @param tleRaw - 2- or 3-line element set text.
   * @param name - Optional display name; falls back to the TLE title line.
   * @param nowUtcMs - Registration time (the route supplies it — the impure boundary).
   * @returns The stored public entry.
   */
  upsert(satId: string, tleRaw: string, name: string | null, nowUtcMs: number): TleCatalogEntry {
    if (!SAT_ID_RE.test(satId)) throw new CatalogError(`invalid satId "${satId}" (alnum start, [a-zA-Z0-9._-], ≤64 chars)`);
    if (typeof tleRaw !== 'string' || tleRaw.length === 0 || tleRaw.length > TLE_MAX_CHARS) {
      throw new CatalogError(`tle is required and must be ≤ ${TLE_MAX_CHARS} characters`);
    }
    const tle = parseTle(tleRaw); // TleParseError propagates → 400 at the route
    const row: CatalogRow = {
      satId,
      name: name ?? tle.name,
      satnum: tle.satnum,
      tleRaw,
      updatedUtcMs: nowUtcMs,
      tle,
    };
    this.rows.set(satId, row);
    return this.publicEntry(row);
  }

  /** @returns The parsed element set for a sat, or null. */
  tleOf(satId: string): ParsedTle | null {
    return this.rows.get(satId)?.tle ?? null;
  }

  /** @returns Every public entry, insertion-ordered. */
  list(): TleCatalogEntry[] {
    return [...this.rows.values()].map((r) => this.publicEntry(r));
  }

  /**
   * @description Remove one row.
   * @param satId - Row to remove.
   * @returns Whether a row existed.
   */
  remove(satId: string): boolean {
    return this.rows.delete(satId);
  }

  /**
   * @description Build the screening set for {@link screenConjunctions}.
   * @param ids - Subset of satIds; omitted → the whole catalog. Unknown ids throw.
   * @returns Screen entries in catalog order.
   */
  screenEntries(ids?: string[]): ScreenEntry[] {
    if (!ids || ids.length === 0) return [...this.rows.values()].map((r) => ({ id: r.satId, tle: r.tle }));
    return ids.map((id) => {
      const row = this.rows.get(id);
      if (!row) throw new CatalogError(`satId "${id}" is not in the catalog`);
      return { id: row.satId, tle: row.tle };
    });
  }

  private publicEntry(row: CatalogRow): TleCatalogEntry {
    return { satId: row.satId, name: row.name, satnum: row.satnum, tleRaw: row.tleRaw, updatedUtcMs: row.updatedUtcMs };
  }
}
