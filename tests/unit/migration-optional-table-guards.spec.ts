/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the optional-feature migration class that took the gsquared production stack down on 2026-09-05: the oshal_trading_* side-stores are RUNTIME-created by the trading feature, so migration 124's bare `ALTER TABLE oshal_trading_daily_equity` failed the managed-postgres launcher gate on a box that never ran trading, and the whole stack refused to start. Two rules, both proven red against the unfixed files: (1) a top-level statement may reference an oshal_trading_ relation only when the migration ladder itself CREATEs it (cumulatively) — everything else goes inside a to_regclass-guarded DO block; (2) a literal '...'::regclass cast on a runtime-only oshal_trading_ name is banned anywhere, because it throws at PLAN time where no IF/AND guard can reach — use to_regclass(), which yields NULL.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'scripts', 'migrations');

/** Strip SQL comments and DO $$…$$ bodies, leaving only top-level statements. */
function topLevelSql(sql: string): string {
  const noComments = sql.replace(/--[^\n]*/g, '');
  // DO blocks (any $tag$) are the sanctioned place for guarded optional-table work.
  return noComments.replace(/DO\s+(\$[a-zA-Z_]*\$)[\s\S]*?\1\s*;/g, ';');
}

/** Relations a file creates at top level. */
function createdHere(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)/gi)) out.add(m[1].toLowerCase());
  for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_]+)/gi)) out.add(m[1].toLowerCase());
  return out;
}

describe('migrations never assume runtime-created optional tables', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  /** CUMULATIVE created-set: a table CREATEd at top level by any migration is ladder-guaranteed
   *  on every deployment. Only tables no migration creates — the runtime-self-healed trading
   *  side-stores — are optional and must be guarded. */
  const ladderCreated = new Set<string>();
  for (const f of files) for (const t of createdHere(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))) ladderCreated.add(t);

  it('top-level statements only touch oshal_trading_ relations the ladder itself creates', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const top = topLevelSql(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
      for (const m of top.matchAll(/\b(?:ALTER\s+TABLE|UPDATE|INSERT\s+INTO|CREATE\s+(?:UNIQUE\s+)?INDEX[^;]*?\bON)\s+(oshal_trading_[a-z_]+)/gi)) {
        const table = m[1].toLowerCase();
        if (!ladderCreated.has(table)) offenders.push(`${f}: top-level statement on runtime-created ${table}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('never casts a runtime-only oshal_trading_ literal with ::regclass — it throws at plan time', () => {
    // A cast on a ladder-created table is fine; a cast on a runtime-only side-store throws
    // DURING PLANNING, where no IF/AND guard can reach it. to_regclass() yields NULL instead.
    const offenders: string[] = [];
    for (const f of files) {
      const noComments = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8').replace(/--[^\n]*/g, '');
      for (const m of noComments.matchAll(/'(oshal_trading_[a-z_]+)'::regclass/gi)) {
        if (!ladderCreated.has(m[1].toLowerCase())) {
          offenders.push(`${f}: plan-time cast '${m[1]}'::regclass — use to_regclass()`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
