/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE/TIME           | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2026-07-29 10:45:00 | roger.murphy@emeraldcoastsystemsgroup.com   | Guard for the cockpit busy-count column: the DA-5 breakdown queried work_items.agent_id, a column migration 007 never created (it is assigned_agent_id), so the query failed on EVERY deployment and its catch quietly rendered busy=0 — invisible until the first fresh-schema customer box made the 30-second Postgres error drumbeat obvious. This spec pins every work_items column referenced in cockpit-routes.ts to the columns the migration actually defines, so a renamed or imagined column goes red here instead of degrading silently behind a catch.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('cockpit busy-count query vs the work_items schema', () => {
  it('references only columns migration 007 actually creates', () => {
    const routes = fs.readFileSync(path.resolve(process.cwd(), 'src/app/routes/cockpit-routes.ts'), 'utf8');
    const ddl = fs.readFileSync(path.resolve(process.cwd(), 'scripts/migrations/007-work-items.sql'), 'utf8');

    const queries = routes.match(/SELECT[^`]*FROM work_items[^`]*/g) ?? [];
    expect(queries.length).toBeGreaterThan(0);

    // Columns the migration defines (first parenthesized block of the CREATE TABLE).
    const createBlock = ddl.slice(ddl.indexOf('work_items ('));
    const definedColumns = new Set(
      [...createBlock.matchAll(/^\s{2,}([a-z_]+)\s/gm)].map((m) => m[1]),
    );
    expect(definedColumns.has('assigned_agent_id')).toBe(true);
    expect(definedColumns.has('agent_id')).toBe(false); // the column that never existed

    for (const q of queries) {
      // Identifiers used in column position: after SELECT/DISTINCT/WHERE/AND, bare words
      // that are not SQL keywords or literals.
      const identifiers = [...q.matchAll(/(?:DISTINCT|WHERE|AND|BY)\s+([a-z_]+)/g)].map((m) => m[1]);
      for (const id of identifiers) {
        if (['status', 'count', 'cnt'].includes(id)) continue;
        expect(definedColumns.has(id), `cockpit-routes queries work_items.${id} which migration 007 does not define`).toBe(true);
      }
    }
  });
});
