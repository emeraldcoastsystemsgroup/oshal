/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Enumerates every lazy-DDL guard under src/ that keys a trigger or function on its NAME alone and holds each to the contract from the consent-ledger drift (8a88d33e): converge on a property of the live object, or carry a reviewed known-set entry whose source and live definitions are pinned. A new guard, a moved guard, a vanished guard, or a changed CREATE statement without a convergence decision is red; an empty inventory is red too, never a pass.
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_BY_NAME_GUARDS, findByNameGuards, scanByNameGuards } from '../helpers/lazy-ddl-guards';

const REPO = resolve(__dirname, '../..');
const SRC = resolve(REPO, 'src');

const key = (guard: { kind: string; object: string; file: string; line: number }): string =>
  `${guard.kind} ${guard.object} @ ${guard.file}:${guard.line}`;

/** Every by-name shape the scanner must catch, plus one block that converges on tgtype. */
const FIXTURE_BY_NAME = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='fx_fn') THEN
    CREATE FUNCTION fx_fn() RETURNS trigger AS $b$ BEGIN RETURN NEW; END; $b$ LANGUAGE plpgsql;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='fx_trg') THEN
    CREATE TRIGGER fx_trg BEFORE UPDATE ON fx_table
      FOR EACH ROW EXECUTE FUNCTION fx_fn();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'fx_trg2') THEN
    CREATE TRIGGER fx_trg2 AFTER INSERT ON fx_table FOR EACH ROW EXECUTE FUNCTION fx_fn();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_name = 'fx_fn2') THEN
    CREATE FUNCTION fx_fn2() RETURNS void AS $b$ BEGIN END; $b$ LANGUAGE plpgsql;
  END IF;
END $$;
DO $$ BEGIN
  IF to_regproc('fx_fn3') IS NULL THEN
    CREATE FUNCTION fx_fn3() RETURNS void AS $b$ BEGIN END; $b$ LANGUAGE plpgsql;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='fx_conv' AND (tgtype::int & 8) <> 0) THEN
    DROP TRIGGER fx_conv ON fx_table;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='fx_conv') THEN
    CREATE TRIGGER fx_conv BEFORE UPDATE ON fx_table FOR EACH ROW EXECUTE FUNCTION fx_fn();
  END IF;
END $$;
`;

/** DDL that converges by construction, and a read-only catalog inventory: none of it is a by-name guard. */
const FIXTURE_CONVERGING = `
CREATE OR REPLACE FUNCTION fx_fill() RETURNS trigger AS $b$ BEGIN RETURN NEW; END; $b$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS fx_fill_trg ON fx_table;
CREATE TRIGGER fx_fill_trg BEFORE INSERT ON fx_table FOR EACH ROW EXECUTE FUNCTION fx_fill();
SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'access_audit_log' AND NOT t.tgisinternal;
CREATE TABLE IF NOT EXISTS fx_table (id INT);
CREATE INDEX IF NOT EXISTS fx_idx ON fx_table (id);
`;

describe('lazy-DDL guards that key a trigger or function on its name alone', () => {
  const found = scanByNameGuards(SRC, REPO);

  it('recognizes every by-name shape and ignores converging DDL and read-only catalog reads', () => {
    const hits = findByNameGuards(FIXTURE_BY_NAME, 'fixture.sql');
    expect(hits.map((g) => `${g.kind} ${g.object} converges=[${g.convergesOn.join(',')}]`)).toEqual([
      'function fx_fn converges=[]',
      'trigger fx_trg converges=[]',
      'trigger fx_trg2 converges=[]',
      'function fx_fn2 converges=[]',
      'function fx_fn3 converges=[]',
      'trigger fx_conv converges=[tgtype]',
    ]);
    expect(hits[1].createStatement).toBe('CREATE TRIGGER fx_trg BEFORE UPDATE ON fx_table FOR EACH ROW EXECUTE FUNCTION fx_fn()');
    expect(hits[0].createStatement).toBe('CREATE FUNCTION fx_fn() RETURNS trigger AS $b$ BEGIN RETURN NEW; END; $b$ LANGUAGE plpgsql');
    expect(hits.map((g) => g.line)).toEqual([3, 8, 14, 19, 24, 32]);
    expect(findByNameGuards(FIXTURE_CONVERGING, 'fixture.sql')).toEqual([]);
  });

  it('does not report an empty inventory as a clean tree', () => {
    expect(found.length, 'the scanner found nothing under src/ - it is broken, not the tree clean').toBeGreaterThan(0);
  });

  it('lists every guard under src/ in the known set at its recorded file:line, and every known entry still exists', () => {
    expect(
      found.map(key).sort(),
      'a NEW by-name guard needs a convergence path or a reviewed known-set entry; a MOVED one needs its line updated; a REMOVED one leaves the known set',
    ).toEqual(KNOWN_BY_NAME_GUARDS.map(key).sort());
  });

  it('holds each known guard to its reviewed convergence and its pinned CREATE statement', () => {
    for (const known of KNOWN_BY_NAME_GUARDS) {
      const scanned = found.find((g) => g.file === known.file && g.kind === known.kind && g.object === known.object);
      expect(scanned, key(known)).toBeDefined();
      expect(known.reason.length, `${key(known)} needs a reason`).toBeGreaterThan(0);
      expect(known.liveDefinition.length, `${key(known)} needs a live-definition pin`).toBeGreaterThan(0);
      expect(scanned!.convergesOn, `${key(known)} convergence`).toEqual(known.convergesOn);
      expect(
        scanned!.createStatement,
        `${key(known)}: the CREATE statement changed. An existing deployment keeps the OLD object unless the guard converges on the difference - extend the convergence predicate, or record the new pin deliberately.`,
      ).toBe(known.createStatement);
    }
  });

  it('keeps the pinned live rendering consistent with the pinned source', () => {
    for (const known of KNOWN_BY_NAME_GUARDS) {
      if (known.kind === 'trigger') {
        // pg_get_triggerdef always schema-qualifies the table; nothing else differs from the source.
        expect(known.liveDefinition, key(known)).toBe(known.createStatement.replace(/\bON\s+(?!public\.)(\w+)/i, 'ON public.$1'));
      } else {
        // prosrc is the body between the dollar quotes.
        expect(known.createStatement, key(known)).toContain(known.liveDefinition);
      }
    }
  });
});
