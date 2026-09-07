/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fail-open on PROTECTIVE EXITS (2026-09-06 round-4 review): a DISABLED live book was invisible to the watchdog end to end - the roster filtered `AND enabled` in SQL, the leg read dropped any leg whose book was not in that set, and the evaluation returned early on an empty set. But disabling a book stops NEW risk only (trading-schedule-dispatch logs "book disabled - new entries skipped (exits/sells still ran)"), so its autopilot leg keeps running the hard stops / take-profits / trailing exits: a disabled book's leg could die and take the real-money stops with it, silently. The roster now returns every live book with an Enabled flag and the states are alerted apart - 'live-exits-silent-<ref>' for a DISABLED book whose ACTIVE leg shows no beat, while a DISABLED book with a paused leg or no leg stays SILENT (both switches off). New cases prove (a) the disabled+active+silent report, (b) the disabled+legless / disabled+paused silence against an ENABLED contrast that does alert, (c) every enabled-book expectation unchanged, plus the all-disabled roster split (honest empty leg map = quiet, leg-read FAILURE = still 'legs-unreadable'), the disabled book's ACTIVE leg mapped through the REAL Redis store, and a source pin on the dispatch lines that make the premise true.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fail-open coverage hole (2026-09-06 review): a PAUSED autopilot leg for an ENABLED live book used to fall through to the legless bucket and be satisfied by the per-sub events tick whenever some OTHER book still had an active leg - the exact silence the old '_live' grep paged on. Get-AutopilotLegRefs now returns Legs + Paused separately and Test-LiveBookBeats raises 'live-leg-paused-<ref>' for those books; a third seeded book (b-spec-paused, enabled, leg status 'paused') proves it through the real Redis store. Also: cleanup DELs the seeded schedule records BY PATTERN (the run's own prefix) rather than only the keys it remembers, and the real-boundary timeouts are 90s (three runs on a loaded box put a 60s PowerShell+docker case on the edge).
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-134 D2 #7 watchdog guard. Proves, through the REAL PowerShell 5.1 boundary, that scripts/trading-watchdog.ps1 derives its expected live set FROM oshal_trading_books (docker exec psql against the live Postgres: enabled live books in, disabled/paper out), maps autopilot legs from the REAL Redis schedule store (seeded records in the real shape: legacy no-bookId+mode live -> 'live', taskData.bookId -> its book, inactive/foreign ignored), evaluates beats per book on the leg's own "scheduleId", and FAILS CLOSED (books unreadable -> 'books-unreadable' + legacy live assumed; empty leg map -> 'legs-unreadable' + the legacy live beat still required; legless book -> the per-sub trading-events tick). Also executes scripts/trading-books-cutover.sh's check_observability_pair under bash with stub docker/schtasks for every refuse branch and one pass, source-pins the two cross-module log strings the watchdog depends on, pins that the leg read is attempted even when the books read failed (so 'legs-unreadable' never names a schedule store the run did not consult), and pins that every docker/psql target is a parameter rather than a literal container name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { ensureLegacyBooks, legacyBookId } from '../../src/app/trading-books-store';

const root = join(__dirname, '..', '..');
const watchdogPath = join(root, 'scripts', 'trading-watchdog.ps1');
const cutoverPath = join(root, 'scripts', 'trading-books-cutover.sh');
const watchdogSource = readFileSync(watchdogPath, 'utf8');
const cutoverSource = readFileSync(cutoverPath, 'utf8');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const scratch = mkdtempSync(join(tmpdir(), 'oshal-watchdog-books-'));
const DSN = process.env.OSHAL_TEST_DSN || `postgresql://oshal:oshal@127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}/oshal`;
const DB_CONTAINER = process.env.OSHAL_TEST_DB_CONTAINER || 'oshal-local-db';
const REDIS_CONTAINER = process.env.OSHAL_TEST_REDIS_CONTAINER || 'oshal-local-redis';
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-adr134wd-${RUN}`;
const B_ON = crypto.randomUUID();
const B_OFF = crypto.randomUUID();
const B_PAUSED = crypto.randomUUID();
// DISABLED live book whose autopilot leg is ACTIVE — the round-4 hole: its protective exits still
// run, so a silent leg is a real-money failure the watchdog used to filter out of existence.
const B_OFF_ACTIVE = crypto.randomUUID();
const redisKeys: string[] = [];
let pool: Pool;

const sourceSection = (start: string, end: string): string => {
  const startAt = watchdogSource.indexOf(start);
  const endAt = watchdogSource.indexOf(end, startAt);
  if (startAt < 0 || endAt < 0) throw new Error(`watchdog source markers missing: ${start} -> ${end}`);
  return watchdogSource.slice(startAt, endAt);
};
const bookFunctions = sourceSection('# ---- per-book beat derivation', '# A) api health');

/** Harness: stub Log/Raise, dot the real functions, dispatch on $Mode, print JSON. */
const harnessPath = join(scratch, 'books-harness.ps1');
writeFileSync(harnessPath, [
  'param([string]$Mode, [string]$Sub, [string]$BooksJson, [string]$LegsJson, [string]$PausedJson, [string]$LinesFile, [string]$MultiFlag, [string]$DbContainer, [string]$DbUser, [string]$DbName, [string]$RedisContainer)',
  '$ErrorActionPreference = "Continue"',
  '$script:raised = New-Object System.Collections.ArrayList',
  'function Log($m) {}',
  'function Raise($cond, $msg) { [void]$script:raised.Add(@{ cond = $cond; msg = $msg }) }',
  'function FromJsonFile($p) { if (-not $p -or $p -eq "null") { return $null } $t = Get-Content -LiteralPath $p -Raw; if ($t.Trim() -eq "null") { return $null } return ($t | ConvertFrom-Json) }',
  bookFunctions,
  'switch ($Mode) {',
  '  "books" { $r = Get-ExpectedLiveBooks $Sub; if (-not $r.Ok) { "null" } else { ConvertTo-Json -Compress -InputObject @(@($r.Books) | ForEach-Object { @{ Ref = $_.Ref; BookId = $_.BookId; Enabled = $_.Enabled } }) } }',
  '  "legs" { $books = @(); foreach ($b in @(FromJsonFile $BooksJson)) { $books += @{ Ref = $b.Ref; BookId = $b.BookId } }; $r = Get-AutopilotLegRefs $Sub $books; if ($null -eq $r) { "null" } else { ConvertTo-Json -Compress -Depth 4 -InputObject $r } }',
  '  "eval" {',
  // Enabled mirrors what Get-ExpectedLiveBooks always sets. A fixture that omits it means ENABLED,
  // so every pre-round-4 case below still asserts the ENABLED behaviour with its body untouched.
  '    $books = FromJsonFile $BooksJson; if ($null -ne $books) { $tmp = @(); foreach ($b in @($books)) { $en = if ($null -eq $b.Enabled) { $true } else { [bool]$b.Enabled }; $tmp += @{ Ref = $b.Ref; BookId = $b.BookId; Enabled = $en } }; $books = $tmp }',
  '    $legs = FromJsonFile $LegsJson; if ($null -ne $legs) { $h = @{}; foreach ($p in $legs.psobject.properties) { $h[$p.Name] = [string]$p.Value }; $legs = $h }',
  '    $paused = FromJsonFile $PausedJson; if ($null -ne $paused) { $h2 = @{}; foreach ($p in $paused.psobject.properties) { $h2[$p.Name] = [string]$p.Value }; $paused = $h2 }',
  '    $lines = @(Get-Content -LiteralPath $LinesFile)',
  '    Test-LiveBookBeats $lines $books $legs $MultiFlag 20 $paused',
  '    ConvertTo-Json -Compress -InputObject @($script:raised | ForEach-Object { $_.cond } | Sort-Object)',
  '  }',
  '}',
].join('\n'));

const runHarness = (args: Record<string, string>): { status: number | null; out: string; err: string } => {
  const argv: string[] = [];
  for (const [k, v] of Object.entries(args)) argv.push(`-${k}`, v);
  const r = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessPath, ...argv], { encoding: 'utf8', timeout: 75_000 });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
};
const jsonFile = (name: string, value: unknown): string => { const p = join(scratch, name); writeFileSync(p, JSON.stringify(value)); return p; };
const linesFile = (name: string, lines: string[]): string => { const p = join(scratch, name); writeFileSync(p, lines.join('\n') + '\n'); return p; };
const lastJson = <T>(out: string): T => JSON.parse(out.split(/\r?\n/).filter(Boolean).at(-1) ?? 'null') as T;

const legacyLegId = `trading-autopilot_${SUB}_live`;
const bookLegId = `trading-autopilot_${SUB}--${'a'.repeat(24)}`;
const pausedLegId = `trading-autopilot_${SUB}--${'c'.repeat(24)}`;
const offPausedLegId = `trading-autopilot_${SUB}--${'b'.repeat(24)}`;
const offActiveLegId = `trading-autopilot_${SUB}--${'d'.repeat(24)}`;
const pino = (fields: Record<string, unknown>, msg: string): string => JSON.stringify({ level: 30, time: new Date().toISOString(), module: 'trading-schedule-dispatch', ...fields, msg });
const RUN_COMPLETE = 'autopilot run complete';
const TICK = 'event plans + protected lots + dated orders tick';

const docker = (args: string[]): string => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed (the live stack must be up: bash scripts/oshal-up.sh): ${r.stderr}`);
  return (r.stdout ?? '').trim();
};
const redisSet = (id: string, record: object): void => {
  const key = `oshal:scheduler:schedule:${id}`;
  redisKeys.push(key);
  docker(['exec', REDIS_CONTAINER, 'redis-cli', 'SET', key, JSON.stringify(record)]);
};

beforeAll(async () => {
  pool = new Pool({ connectionString: DSN, max: 2, options: '-c row_security=off' });
  try { await pool.query('SELECT 1'); } catch (error) {
    throw new Error(`trading-watchdog-books requires the live oshal Postgres — bring the stack up with \`bash scripts/oshal-up.sh\` (cause: ${(error as Error).message})`);
  }
  await ensureLegacyBooks(pool as never, SUB);
  // Explicit created_at so the roster's ORDER BY is deterministic rather than insert-latency luck.
  const seedBook = (id: string, ref: string, label: string, enabled: boolean, secs: number) =>
    pool.query(
      `INSERT INTO oshal_trading_books (book_id, user_sub, ref, label, kind, broker, enabled, created_at)
       VALUES ($1,$2,$3,$4,'live','schwab',$5, now() + ($6 || ' seconds')::interval)`,
      [id, SUB, ref, label, enabled, String(secs)]);
  await seedBook(B_ON, 'b-spec-on', 'Spec margin', true, 1);
  await seedBook(B_OFF, 'b-spec-off', 'Spec cash', false, 2);
  // ENABLED live book whose only autopilot leg is PAUSED — the round-3 fail-open hole.
  await seedBook(B_PAUSED, 'b-spec-paused', 'Spec paused', true, 3);
  // DISABLED live book with an ACTIVE leg — the round-4 hole (its protective exits still run).
  await seedBook(B_OFF_ACTIVE, 'b-spec-off-live', 'Spec disabled-but-running', false, 4);
  // Real schedule records in the store's shape (id/taskType/taskData/status/ownerSub/queue).
  const base = { cron: '*/5 * * * *', status: 'active', ownerSub: SUB, queue: 'intelligent-trades', createdAt: '2026-09-01T00:00:00.000Z' };
  redisSet(legacyLegId, { ...base, id: legacyLegId, taskType: `trading-autopilot:${SUB}:live`, taskData: { prompt: 'legacy live leg', userSub: SUB, mode: 'live' } });
  redisSet(`trading-autopilot_${SUB}`, { ...base, id: `trading-autopilot_${SUB}`, taskType: `trading-autopilot:${SUB}`, taskData: { prompt: 'paper leg', userSub: SUB, mode: 'paper' } });
  redisSet(bookLegId, { ...base, id: bookLegId, taskType: `trading-autopilot:${SUB}:b-spec-on`, taskData: { prompt: 'book leg', userSub: SUB, mode: 'live', bookId: B_ON } });
  redisSet(offPausedLegId, { ...base, id: offPausedLegId, status: 'paused', taskType: `trading-autopilot:${SUB}:b-spec-off`, taskData: { userSub: SUB, mode: 'live', bookId: B_OFF } });
  redisSet(offActiveLegId, { ...base, id: offActiveLegId, taskType: `trading-autopilot:${SUB}:b-spec-off-live`, taskData: { prompt: 'disabled book, running leg', userSub: SUB, mode: 'live', bookId: B_OFF_ACTIVE } });
  redisSet(pausedLegId, { ...base, id: pausedLegId, status: 'paused', taskType: `trading-autopilot:${SUB}:b-spec-paused`, taskData: { prompt: 'paused book leg', userSub: SUB, mode: 'live', bookId: B_PAUSED } });
  redisSet(`trading-autopilot_${SUB}-other_live`, { ...base, id: `trading-autopilot_${SUB}-other_live`, ownerSub: `${SUB}-other`, taskType: 'trading-autopilot:x:live', taskData: { userSub: `${SUB}-other`, mode: 'live' } });
}, 120_000);

afterAll(async () => {
  // BY PATTERN, not just the keys we remember: these are live-mode autopilot records in the
  // PRODUCTION schedule store, so a half-cleaned run must not leave any behind (they are not
  // dispatchable — the store reads its id index / next-run zset, which a raw SET never touches —
  // but leaving them is still litter in a real trading deployment's Redis).
  const stale = docker(['exec', REDIS_CONTAINER, 'redis-cli', '--scan', '--pattern', `oshal:scheduler:schedule:trading-autopilot_${SUB}*`]);
  for (const key of new Set([...redisKeys, ...stale.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)])) {
    try { docker(['exec', REDIS_CONTAINER, 'redis-cli', 'DEL', key]); } catch { /* best effort */ }
  }
  await pool.query(`DELETE FROM oshal_trading_books WHERE user_sub LIKE 'spec-adr134wd-%'`).catch(() => {});
  await pool.end();
  rmSync(scratch, { recursive: true, force: true });
}, 120_000);

describe('Get-ExpectedLiveBooks — the expected set comes FROM oshal_trading_books (real psql through docker exec)', () => {
  it('returns EVERY live book — enabled AND disabled — each carrying its own Enabled flag; never paper', () => {
    // Round 4: `AND enabled` used to be in the SQL, which is what made a disabled book's still-running
    // protective exits unwatchable. The flag now travels with the row instead of filtering it away.
    const r = runHarness({ Mode: 'books', Sub: SUB, DbContainer: DB_CONTAINER, DbUser: 'oshal', DbName: 'oshal' });
    expect(r.status, `${r.out}\n${r.err}`).toBe(0);
    const books = lastJson<Array<{ Ref: string; BookId: string; Enabled: boolean }>>(r.out);
    expect(books, r.out).not.toBeNull();
    expect(books.map((b) => b.Ref)).toEqual(['live', 'b-spec-on', 'b-spec-off', 'b-spec-paused', 'b-spec-off-live']);
    expect(books.map((b) => b.Enabled)).toEqual([true, true, false, true, false]);
    expect(books.find((b) => b.Ref === 'live')?.BookId).toBe(legacyBookId(SUB, 'live'));
    expect(books.find((b) => b.Ref === 'b-spec-on')?.BookId).toBe(B_ON);
    expect(books.find((b) => b.Ref === 'b-spec-off-live')?.BookId).toBe(B_OFF_ACTIVE);
  }, 90_000);

  it('returns $null (fail-closed signal) when the DB container is wrong, and an empty set for a sub with no live books', () => {
    const bad = runHarness({ Mode: 'books', Sub: SUB, DbContainer: `no-such-container-${RUN}`, DbUser: 'oshal', DbName: 'oshal' });
    expect(bad.status).toBe(0);
    expect(bad.out.split(/\r?\n/).at(-1)).toBe('null');
    const none = runHarness({ Mode: 'books', Sub: `${SUB}-nobody`, DbContainer: DB_CONTAINER, DbUser: 'oshal', DbName: 'oshal' });
    expect(none.status, none.err).toBe(0);
    expect(lastJson<unknown[]>(none.out)).toEqual([]);
  }, 90_000);
});

describe('Get-AutopilotLegRefs — legs come from the REAL Redis schedule store', () => {
  it('splits ACTIVE legs from PAUSED ones: legacy no-bookId+mode=live -> "live", taskData.bookId -> its book, a paused leg lands in Paused, foreign legs are ignored', () => {
    const books = jsonFile('books.json', [
      { Ref: 'live', BookId: legacyBookId(SUB, 'live') }, { Ref: 'b-spec-on', BookId: B_ON }, { Ref: 'b-spec-paused', BookId: B_PAUSED },
    ]);
    const r = runHarness({ Mode: 'legs', Sub: SUB, BooksJson: books, RedisContainer: REDIS_CONTAINER });
    expect(r.status, `${r.out}\n${r.err}`).toBe(0);
    expect(lastJson<{ Legs: Record<string, string>; Paused: Record<string, string> }>(r.out)).toEqual({
      Legs: { live: legacyLegId, 'b-spec-on': bookLegId },
      Paused: { 'b-spec-paused': `${pausedLegId} status=paused` },
    });
  }, 90_000);

  it('maps a DISABLED book\u2019s legs too (active AND paused) — the roster hands them over, so the leg that still runs its protective exits is visible', () => {
    const books = jsonFile('books-off.json', [
      { Ref: 'b-spec-off', BookId: B_OFF, Enabled: false }, { Ref: 'b-spec-off-live', BookId: B_OFF_ACTIVE, Enabled: false },
    ]);
    const r = runHarness({ Mode: 'legs', Sub: SUB, BooksJson: books, RedisContainer: REDIS_CONTAINER });
    expect(r.status, `${r.out}\n${r.err}`).toBe(0);
    const map = lastJson<{ Legs: Record<string, string>; Paused: Record<string, string> }>(r.out);
    expect(map.Legs).toEqual({ live: legacyLegId, 'b-spec-off-live': offActiveLegId });
    expect(map.Paused).toEqual({ 'b-spec-off': `${offPausedLegId} status=paused` });
  }, 90_000);

  it('a paused leg for a book that is NOT in the set handed to the read is ignored entirely', () => {
    const books = jsonFile('books-noff.json', [{ Ref: 'live', BookId: legacyBookId(SUB, 'live') }]);
    const r = runHarness({ Mode: 'legs', Sub: SUB, BooksJson: books, RedisContainer: REDIS_CONTAINER });
    expect(r.status, `${r.out}\n${r.err}`).toBe(0);
    const map = lastJson<{ Legs: Record<string, string>; Paused: Record<string, string> }>(r.out);
    expect(map.Legs).toEqual({ live: legacyLegId });
    expect(map.Paused).toEqual({});
  }, 90_000);

  it('returns $null when the Redis container is unreachable (the caller fails closed)', () => {
    const books = jsonFile('books2.json', [{ Ref: 'live', BookId: legacyBookId(SUB, 'live') }]);
    const r = runHarness({ Mode: 'legs', Sub: SUB, BooksJson: books, RedisContainer: `no-such-redis-${RUN}` });
    expect(r.status).toBe(0);
    expect(r.out.split(/\r?\n/).at(-1)).toBe('null');
  }, 90_000);
});

describe('Test-LiveBookBeats — per-book evaluation, fail-closed', () => {
  const books = jsonFile('eval-books.json', [{ Ref: 'live', BookId: legacyBookId(SUB, 'live') }, { Ref: 'b-spec-on', BookId: B_ON }]);
  const legs = jsonFile('eval-legs.json', { live: legacyLegId, 'b-spec-on': bookLegId });
  const noPaused = jsonFile('no-paused.json', {});
  const evalRun = (linesPath: string, booksPath: string, legsPath: string, flag = 'true', pausedPath = noPaused) => {
    const r = runHarness({ Mode: 'eval', Sub: SUB, BooksJson: booksPath, LegsJson: legsPath, PausedJson: pausedPath, LinesFile: linesPath, MultiFlag: flag });
    expect(r.status, `${r.out}\n${r.err}`).toBe(0);
    return lastJson<string[]>(r.out);
  };

  it('raises exactly live-loop-silent-<ref> for the book whose leg has no "run complete" line (matched on that leg\'s own scheduleId)', () => {
    const lines = linesFile('l1.txt', [
      pino({ scheduleId: legacyLegId, session: 'regular', orders: 0 }, RUN_COMPLETE),
      pino({ scheduleId: `trading-autopilot_${SUB}` }, RUN_COMPLETE),
      pino({ sub: SUB, lots: 0, dated: 0 }, TICK),
    ]);
    expect(evalRun(lines, books, legs)).toEqual(['live-loop-silent-b-spec-on']);
  }, 90_000);

  it('raises nothing when every leg beat', () => {
    const lines = linesFile('l2.txt', [pino({ scheduleId: legacyLegId }, RUN_COMPLETE), pino({ scheduleId: bookLegId }, RUN_COMPLETE)]);
    expect(evalRun(lines, books, legs)).toEqual([]);
  }, 90_000);

  it('a beat from a DIFFERENT schedule never satisfies a book (no substring leak across ids)', () => {
    const lines = linesFile('l3.txt', [pino({ scheduleId: `${bookLegId}x` }, RUN_COMPLETE), pino({ scheduleId: legacyLegId }, 'autopilot skipped - market closed')]);
    expect(evalRun(lines, books, legs)).toEqual(['live-loop-silent-b-spec-on', 'live-loop-silent-live']);
  }, 90_000);

  it('FAIL-OPEN GUARD: an EMPTY leg map with books present raises legs-unreadable AND still requires the legacy live beat', () => {
    const emptyLegs = jsonFile('empty-legs.json', {});
    const silent = linesFile('l4.txt', [pino({ scheduleId: `trading-autopilot_${SUB}` }, RUN_COMPLETE)]);
    expect(evalRun(silent, books, emptyLegs)).toEqual(['events-leg-silent', 'legs-unreadable', 'live-loop-silent-live']);
    const legacyBeat = linesFile('l5.txt', [pino({ scheduleId: legacyLegId }, RUN_COMPLETE), pino({ sub: SUB }, TICK)]);
    expect(evalRun(legacyBeat, books, emptyLegs)).toEqual(['legs-unreadable']);
  }, 90_000);

  it('a $null books read raises books-unreadable and falls back to requiring the legacy live book (never zero required beats)', () => {
    const nullFile = jsonFile('null.json', null);
    const silent = linesFile('l6.txt', [pino({ scheduleId: `trading-autopilot_${SUB}` }, RUN_COMPLETE)]);
    expect(evalRun(silent, nullFile, nullFile)).toEqual(['books-unreadable', 'legs-unreadable', 'live-loop-silent-live']);
  }, 90_000);

  it('an enabled live book with NO autopilot leg is watched through the per-sub trading-events tick: silent -> events-leg-silent, ticking -> nothing', () => {
    const legsLiveOnly = jsonFile('legs-live-only.json', { live: legacyLegId });
    const noTick = linesFile('l7.txt', [pino({ scheduleId: legacyLegId }, RUN_COMPLETE), pino({ scheduleId: `trading-events_${SUB}` }, 'TRADING_EVENT_PLANS is off - event plans not executed this fire')]);
    const raised = runHarness({ Mode: 'eval', Sub: SUB, BooksJson: books, LegsJson: legsLiveOnly, PausedJson: noPaused, LinesFile: noTick, MultiFlag: 'false' });
    expect(lastJson<string[]>(raised.out)).toEqual(['events-leg-silent']);
    const ticking = linesFile('l8.txt', [pino({ scheduleId: legacyLegId }, RUN_COMPLETE), pino({ sub: SUB, lots: 2, dated: 0 }, TICK)]);
    expect(evalRun(ticking, books, legsLiveOnly)).toEqual([]);
  }, 90_000);

  it('FAIL-OPEN GUARD: an enabled book whose leg is PAUSED raises live-leg-paused-<ref> and is NEVER satisfied by the events tick', () => {
    // The hole this closes: the paused leg used to be dropped by the leg read, so the book looked
    // legless and a ticking trading-events leg silenced it — but only when ANOTHER book still had an
    // active leg (with one book the empty-map branch saved it), i.e. exactly the two-live-book world.
    const legsLiveOnly = jsonFile('legs-live-only-2.json', { live: legacyLegId });
    const pausedMap = jsonFile('paused-map.json', { 'b-spec-on': `${bookLegId} status=paused` });
    const ticking = linesFile('l9.txt', [pino({ scheduleId: legacyLegId }, RUN_COMPLETE), pino({ sub: SUB, lots: 1, dated: 0 }, TICK)]);
    expect(evalRun(ticking, books, legsLiveOnly, 'true', pausedMap)).toEqual(['live-leg-paused-b-spec-on']);
    // …and the same book with NO leg at all still passes on the tick (the legless case is unchanged).
    expect(evalRun(ticking, books, legsLiveOnly)).toEqual([]);
  }, 90_000);

  it('a paused leg is reported with its id and status, and still counts when the leg map itself is empty (fail-closed + paused, not one or the other)', () => {
    const emptyLegs = jsonFile('empty-legs-2.json', {});
    const pausedMap = jsonFile('paused-map2.json', { 'b-spec-on': `${bookLegId} status=paused` });
    const beat = linesFile('l10.txt', [pino({ scheduleId: legacyLegId }, RUN_COMPLETE), pino({ sub: SUB }, TICK)]);
    expect(evalRun(beat, books, emptyLegs, 'true', pausedMap)).toEqual(['legs-unreadable', 'live-leg-paused-b-spec-on']);
    expect(bookFunctions).toMatch(/live-leg-paused/);
    expect(bookFunctions).toMatch(/EXISTS but is NOT active/);
  }, 90_000);

  it('ROUND-4 FAIL-OPEN GUARD: a DISABLED live book whose ACTIVE leg shows NO beat raises live-exits-silent-<ref>', () => {
    // Disabling a book stops NEW entries and rotation ONLY — trading-schedule-dispatch keeps running
    // its hard stop / take-profit / trailing exits. Before this, `AND enabled` in the roster SQL made
    // the book invisible, the leg read dropped its leg, and a dead leg took the stops with it in
    // silence. Distinct key because it loses only the exits, not the entries.
    const mixed = jsonFile('eval-books-off.json', [
      { Ref: 'live', BookId: legacyBookId(SUB, 'live'), Enabled: true },
      { Ref: 'b-spec-off-live', BookId: B_OFF_ACTIVE, Enabled: false },
    ]);
    const bothLegs = jsonFile('eval-legs-off.json', { live: legacyLegId, 'b-spec-off-live': offActiveLegId });
    const silent = linesFile('d1.txt', [pino({ scheduleId: legacyLegId }, RUN_COMPLETE), pino({ sub: SUB }, TICK)]);
    expect(evalRun(silent, mixed, bothLegs)).toEqual(['live-exits-silent-b-spec-off-live']);
    // …and it is NOT the enabled key: the enabled book's own silence still reads live-loop-silent.
    const bothSilent = linesFile('d2.txt', [pino({ scheduleId: `trading-autopilot_${SUB}` }, RUN_COMPLETE), pino({ sub: SUB }, TICK)]);
    expect(evalRun(bothSilent, mixed, bothLegs)).toEqual(['live-exits-silent-b-spec-off-live', 'live-loop-silent-live']);
    // When the disabled book's leg DOES beat, nothing is raised.
    const beating = linesFile('d3.txt', [pino({ scheduleId: legacyLegId }, RUN_COMPLETE), pino({ scheduleId: offActiveLegId }, RUN_COMPLETE)]);
    expect(evalRun(beating, mixed, bothLegs)).toEqual([]);
  }, 90_000);

  it('a DISABLED live book with NO leg (or a PAUSED one) is NOT reported at all — while the SAME book enabled does alert', () => {
    const off = jsonFile('eval-books-off2.json', [
      { Ref: 'live', BookId: legacyBookId(SUB, 'live'), Enabled: true },
      { Ref: 'b-spec-off', BookId: B_OFF, Enabled: false },
    ]);
    const on = jsonFile('eval-books-on2.json', [
      { Ref: 'live', BookId: legacyBookId(SUB, 'live'), Enabled: true },
      { Ref: 'b-spec-off', BookId: B_OFF, Enabled: true },
    ]);
    const legsLiveOnly = jsonFile('legs-live-only-3.json', { live: legacyLegId });
    const pausedOff = jsonFile('paused-off.json', { 'b-spec-off': `${offPausedLegId} status=paused` });
    // No events tick anywhere in the window, and still silence: both switches are off for that book.
    const noTick = linesFile('d4.txt', [pino({ scheduleId: legacyLegId }, RUN_COMPLETE)]);
    expect(evalRun(noTick, off, legsLiveOnly)).toEqual([]);
    expect(evalRun(noTick, off, legsLiveOnly, 'true', pausedOff)).toEqual([]);
    // The contrast that proves the silence is BECAUSE it is disabled, not a vacuous assertion:
    expect(evalRun(noTick, on, legsLiveOnly)).toEqual(['events-leg-silent']);
    expect(evalRun(noTick, on, legsLiveOnly, 'true', pausedOff)).toEqual(['live-leg-paused-b-spec-off']);
  }, 90_000);

  it('an all-DISABLED roster: an honest EMPTY leg map is quiet, but a leg-map READ FAILURE still raises legs-unreadable', () => {
    // Blindness over a leg that runs protective exits is not a quiet state — but it adds no beat
    // requirement, because a disabled book may legitimately have no leg at all.
    const allOff = jsonFile('eval-books-alloff.json', [{ Ref: 'b-spec-off', BookId: B_OFF, Enabled: false }]);
    const emptyLegs = jsonFile('empty-legs-3.json', {});
    const nullLegs = jsonFile('null-legs.json', null);
    const lines = linesFile('d5.txt', [pino({ scheduleId: `trading-autopilot_${SUB}` }, RUN_COMPLETE)]);
    expect(evalRun(lines, allOff, emptyLegs)).toEqual([]);
    expect(evalRun(lines, allOff, nullLegs)).toEqual(['legs-unreadable']);
  }, 90_000);

  it('the alert text words the flag state and the per-sub nature of the events tick', () => {
    expect(bookFunctions).toMatch(/per-book schedules hard-skip BY DESIGN/);
    expect(bookFunctions).toMatch(/tick is PER SUB/);
    expect(bookFunctions).toMatch(/TRADING_EVENT_PLANS is off' line is not a beat/);
  });
});

describe('source pins — the contracts the watchdog now depends on', () => {
  it('the roster no longer filters on `enabled` in SQL, and the disabled-book key exists', () => {
    expect(bookFunctions).not.toMatch(/kind = 'live' AND enabled/);
    expect(bookFunctions).toMatch(/CASE WHEN enabled THEN 'y' ELSE 'n' END/);
    expect(bookFunctions).toMatch(/live-exits-silent/);
    expect(bookFunctions).toMatch(/PROTECTIVE EXITS \(hard stop \/ take-profit \/ trailing\) still run/);
  });
  it('the kernel dispatch really does keep a DISABLED book\u2019s protective exits running (the premise of live-exits-silent)', () => {
    const dispatch = readFileSync(join(root, 'src', 'app', 'trading-schedule-dispatch.ts'), 'utf8');
    expect(dispatch).toMatch(/book disabled [^\n]*new entries skipped \(exits\/sells still ran\)/);
    expect(dispatch).toMatch(/book disabled [^\n]*rotation skipped \(protective exits still ran\)/);
  });
  it('the watchdog no longer greps the hand-known _live schedule id', () => {
    expect(watchdogSource).not.toContain("Select-String '_live'");
    expect(watchdogSource).toContain('FROM oshal_trading_books');
    expect(watchdogSource).toMatch(/Get-ExpectedLiveBooks \$LiveSub/);
  });
  it('the kernel dispatch logs "autopilot run complete" with scheduleId (what per-book beats key on)', () => {
    const dispatch = readFileSync(join(root, 'src', 'app', 'trading-schedule-dispatch.ts'), 'utf8');
    expect(dispatch).toMatch(/logger\.info\(\{ scheduleId: schedule\.id,[^\n]*'autopilot run complete'\)/);
  });
  it('the event-plans leg logs a tick line the watchdog\'s $EventsTickPattern matches (pinned against the source, not a copied literal)', () => {
    const m = /\$EventsTickPattern = '([^']+)'/.exec(watchdogSource);
    expect(m, 'watchdog no longer defines $EventsTickPattern').not.toBeNull();
    const pattern = new RegExp(m![1]);
    const plans = readFileSync(join(root, 'src', 'app', 'trading-event-plans.ts'), 'utf8');
    const tickMessages = [...plans.matchAll(/logger\.info\(\{ sub,[^\n]*'([^']*tick[^']*)'\)/g)].map((x) => x[1]);
    expect(tickMessages.length, 'trading-event-plans.ts no longer logs a per-fire tick line').toBeGreaterThan(0);
    expect(tickMessages.some((msg) => pattern.test(msg)), `none of ${JSON.stringify(tickMessages)} matches the watchdog pattern /${m![1]}/`).toBe(true);
    expect(pattern.test(TICK)).toBe(true);
  });
  it('the leg read is attempted even when the books read failed, so legs-unreadable never names an unconsulted Redis', () => {
    // The caller block lives outside the dot-sourced section the harness above executes, so this is
    // a source pin: $legBooks falls back to the same assumed legacy book Test-LiveBookBeats uses,
    // and the leg read is gated on THAT, never on the books read having succeeded.
    // Tolerant of reformatting on purpose: item E rewrites this same block, and a byte-exact pin
    // would break on whitespace alone. What must hold: the leg read's argument is $legBooks (the
    // read books OR the assumed legacy book), never gated on the books read having succeeded.
    expect(watchdogSource).toMatch(/\$legBooks\s*=\s*if\s*\(\s*\$null\s+-ne\s+\$liveBooks\s*\)/);
    expect(watchdogSource).toMatch(/Ref\s*=\s*'live'\s*;\s*BookId\s*=\s*''/);
    expect(watchdogSource).toMatch(/Get-AutopilotLegRefs\s+\$LiveSub\s+\$legBooks/);
    expect(watchdogSource).not.toMatch(/Get-AutopilotLegRefs\s+\$LiveSub\s+\$liveBooks/);
  });
  it('every docker/psql target in the watchdog is a parameter, not a literal container name', () => {
    const params = watchdogSource.slice(0, watchdogSource.indexOf('$ErrorActionPreference'));
    for (const p of ['$ApiContainer', '$DbContainer', '$DbUser', '$DbName', '$RedisContainer']) {
      expect(params, `${p} is not a parameter`).toContain(`[string]${p} = '`);
    }
    const body = watchdogSource.slice(watchdogSource.indexOf('$ErrorActionPreference'));
    expect(body).not.toContain('oshal-local-api');
    expect(body).not.toContain('oshal-local-db');
    expect(body).not.toContain('oshal-local-redis');
  });
  it('the watchdog stays pure ASCII (PowerShell 5.1 mojibakes anything else)', () => {
    expect(/^[\x00-\x7f]*$/.test(watchdogSource)).toBe(true);
  });
});

describe('scripts/trading-books-cutover.sh precondition 5 — check_observability_pair, EXECUTED under bash with stubs', () => {
  const fnStart = cutoverSource.indexOf('check_observability_pair() {');
  const fnEnd = cutoverSource.indexOf('\n}\n', fnStart);
  const fnBody = cutoverSource.slice(fnStart, fnEnd + 3);
  const stubDir = join(scratch, 'stubs');
  const harness = join(scratch, 'pair-harness.sh');
  const runPair = (env: Record<string, string>) => {
    const r = spawnSync('bash', [harness], {
      encoding: 'utf8', timeout: 30_000, cwd: root,
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ''}`, ...env },
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  beforeAll(() => {
    expect(fnStart, 'check_observability_pair() missing from cutover.sh').toBeGreaterThan(0);
    rmSync(stubDir, { recursive: true, force: true });
    require('node:fs').mkdirSync(stubDir);
    writeFileSync(join(stubDir, 'docker'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *redis-cli*PING*) if [ "${STUB_REDIS_DOWN:-0}" = "1" ]; then exit 1; fi; echo PONG; exit 0 ;;',
      '  *trading-book-report*) if [ "${STUB_IMAGE_MISSING:-0}" = "1" ]; then exit 1; fi; exit 0 ;;',
      '  *) exit 0 ;;',
      'esac', ''].join('\n'));
    writeFileSync(join(stubDir, 'schtasks'), '#!/bin/sh\nif [ "${STUB_TASK_MISSING:-0}" = "1" ]; then exit 1; fi\nexit 0\n');
    for (const f of ['docker', 'schtasks']) chmodSync(join(stubDir, f), 0o755);
    writeFileSync(harness, `set -uo pipefail\nfail() { echo "REFUSED: $*"; exit 1; }\nnote() { echo "[cutover] $*"; }\n${fnBody}\ncheck_observability_pair\n`);
    writeFileSync(join(scratch, 'old-watchdog.ps1'), "# FROM oshal_trading_books (a half-migrated file)\n$liveBeat = $recentLogs | Select-String '_live' | Select-String $beatPat\n");
    writeFileSync(join(scratch, 'blind-watchdog.ps1'), 'Write-Host nothing\n');
  });

  it('parses under a real bash -n', () => {
    const r = spawnSync('bash', ['-n', cutoverPath], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(cutoverSource).toMatch(/\ncheck_observability_pair\n/);
    expect(fnBody).toContain('FROM oshal_trading_books');
    expect(fnBody).toContain('trading-book-report');
  });
  it('PASSES with the tree watchdog, a registered task, the module in the image and Redis answering', () => {
    const r = runPair({});
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/observability pair present/);
  });
  it('(a) REFUSES a watchdog that does not derive from oshal_trading_books, and one that still greps _live', () => {
    const blind = runPair({ TRADING_WATCHDOG_SCRIPT: join(scratch, 'blind-watchdog.ps1') });
    expect(blind.status).toBe(1);
    expect(blind.out).toMatch(/REFUSED: .*does not derive its live set FROM oshal_trading_books/);
    const old = runPair({ TRADING_WATCHDOG_SCRIPT: join(scratch, 'old-watchdog.ps1') });
    expect(old.status).toBe(1);
    expect(old.out).toMatch(/REFUSED: .*hand-known '_live' schedule id/);
  });
  it('(b) REFUSES when the scheduled task is missing, honoring TRADING_WATCHDOG_TASK_QUERY on a non-Windows host', () => {
    const missing = runPair({ STUB_TASK_MISSING: '1' });
    expect(missing.status).toBe(1);
    expect(missing.out).toMatch(/REFUSED: scheduled task 'OSHAL Trading Watchdog' is not registered/);
    const named = runPair({ STUB_TASK_MISSING: '1', TRADING_WATCHDOG_TASK_NAME: 'My WD' });
    expect(named.out).toMatch(/scheduled task 'My WD' is not registered/);
    const query = runPair({ TRADING_WATCHDOG_TASK_QUERY: 'exit 3' });
    expect(query.status).toBe(1);
    expect(query.out).toMatch(/REFUSED: TRADING_WATCHDOG_TASK_QUERY exited non-zero/);
    expect(runPair({ TRADING_WATCHDOG_TASK_QUERY: 'exit 0', STUB_TASK_MISSING: '1' }).status).toBe(0);
  });
  it('(c) REFUSES when the running image lacks the per-book report module', () => {
    const r = runPair({ STUB_IMAGE_MISSING: '1' });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/REFUSED: api image lacks the per-book report module .*oshal-deploy\.sh/);
  });
  it('(d) REFUSES when the Redis schedule store does not answer PING', () => {
    const r = runPair({ STUB_REDIS_DOWN: '1' });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/REFUSED: redis container oshal-local-redis does not answer PING/);
  });
});
