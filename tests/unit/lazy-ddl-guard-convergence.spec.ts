/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Enumerates every lazy-DDL guard under src/ that keys a trigger or function on its NAME alone and holds each to the contract from the consent-ledger drift (8a88d33e): converge on a property of the live object, or carry a reviewed known-set entry whose source and live definitions are pinned. A new guard, a moved guard, a vanished guard, or a changed CREATE statement without a convergence decision is red; an empty inventory is red too, never a pass.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Inventory guard: the lazy person-model DDL may be applied from exactly ONE file outside src/ - the real-Postgres parity gate. It had a hand-kept twin (scripts/person-model-gate-in-container.js, written 2026-09-12 when this box could not publish a Docker port, retired 2026-09-21) whose assertions were typed out a second time and were already a whole case short of the spec's, so the in-container run reported PASS while proving less. The gate now starts its own PostgreSQL, so a second copy has no reason to exist and this case is what keeps one from being added back.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
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

/** Roots a second copy of the real-Postgres parity gate would live in: src/ is where the lazy DDL is
 * DEFINED and applied at boot, which is not a gate - a gate is a file that applies it and asserts. */
const GATE_SEARCH_ROOTS = ['tests', 'scripts'];
/** Extensions a runnable gate can have. */
const GATE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs']);
/** Directories with no first-party gate in them. */
const GATE_SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'test-results', '.codex-harness-runs']);
/**
 * The exported factory that returns the lazy person-model DDL statements, spelled in two halves so
 * that THIS file is not a hit on the inventory it takes. A guard that quotes what it looks for
 * counts itself, and is then either permanently red or edited into silence.
 */
const LAZY_DDL_FACTORY = ['personModel', 'SchemaStatements'].join('');

/** A reviewed file outside src/ that applies the lazy person-model DDL. */
interface LazyDdlConsumer {
  /** Repo-relative path with forward slashes. */
  file: string;
  /** Why this one is not a second copy of the parity gate. */
  reason: string;
}

/**
 * @description Every file outside src/ allowed to apply the lazy person-model DDL. The list is the
 * contract: a new entry is a review decision ("is this a second gate?"), not a formality. It exists
 * because this DDL HAD a hand-kept twin - scripts/person-model-gate-in-container.js, written on
 * 2026-09-12 when this box could not publish a Docker port, retired 2026-09-21 - whose assertions
 * were typed out a second time and were already a whole case short of the gate's, so the
 * in-container run printed PASS while proving less than the spec it stood in for.
 */
const KNOWN_LAZY_DDL_CONSUMERS: readonly LazyDdlConsumer[] = [
  {
    file: 'tests/unit/ambient-test-fixture-postgres.spec.ts',
    reason: 'Applies the DDL as SETUP for the Test Lab attributed-ingest fixture and then asserts rows through the real router. It never asserts the catalog shape, so there is nothing here to drift from the parity gate.',
  },
  {
    file: 'tests/unit/person-model-parity-postgres.spec.ts',
    reason: 'THE parity gate: it starts its own pgvector PostgreSQL on an ephemeral loopback port, runs the migration chain, applies the lazy DDL twice and pins the live catalog rendering of every by-name guard. Assertions about the DDL belong here.',
  },
];

/**
 * @description Scans for every file outside src/ that reaches for the lazy person-model DDL factory
 * - that is, every implementation of the real-Postgres parity gate the tree currently carries.
 * @returns Repo-relative paths with forward slashes, sorted.
 */
function filesApplyingLazyPersonModelDdl(): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!GATE_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full);
      } else if (GATE_EXTENSIONS.has(extname(entry.name)) && readFileSync(full, 'utf8').includes(LAZY_DDL_FACTORY)) {
        hits.push(relative(REPO, full).split(sep).join('/'));
      }
    }
  };
  for (const root of GATE_SEARCH_ROOTS) walk(resolve(REPO, root));
  return hits.sort();
}

describe('the real-Postgres person-model parity gate has exactly one implementation', () => {
  it('lists every file outside src/ that applies the lazy person-model DDL in the reviewed set', () => {
    expect(
      filesApplyingLazyPersonModelDdl(),
      'A file applying the lazy DDL either IS the parity gate or is reviewed as something else. An unreviewed one '
      + 'is how a hand-kept twin returns: it is written against a live database nobody re-runs, it is a case short '
      + 'within a month, and it reports PASS the whole time. The gate starts its own PostgreSQL and runs from any '
      + 'host with Docker, so a second copy has no reason to exist - add the assertion to the gate instead.',
    ).toEqual(KNOWN_LAZY_DDL_CONSUMERS.map((consumer) => consumer.file).sort());
  });

  it('keeps every reviewed consumer inside the unit gate, with a reason', () => {
    for (const consumer of KNOWN_LAZY_DDL_CONSUMERS) {
      expect(
        consumer.file,
        `${consumer.file}: a file that applies this DDL must be a unit spec the gate RUNS. The retired twin lived in `
        + 'scripts/ and was run by hand against the api container, which is precisely why nothing noticed it drifting.',
      ).toMatch(/^tests\/unit\/[\w./-]+\.spec\.ts$/);
      expect(consumer.reason.length, `${consumer.file} needs a reason it is not a second gate`).toBeGreaterThan(40);
    }
  });
});
