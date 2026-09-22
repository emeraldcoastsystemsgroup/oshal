/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the two guards the BACKLOG entry "Arming a second autopilot leg is a deliberate, gated act" asks for, both against a REAL disposable PostgreSQL (the defect is a database-backed dispatch decision; a mocked pool would prove nothing about it). (a) The arming gate: a second, ENABLED, non-legacy book with no acknowledgement on its row hard-skips the fire, and the SAME schedule reaches the ordinary live double-opt-in the moment recordArmAck writes the row — the only thing that changed between the two fires is that one row. Withdrawal puts the skip back, and an acknowledgement on one book does nothing for its sibling. (b) `enabled` never widens the dispatched set: with four enabled books on the user, a pool spy records every statement a fire executes, and every read of oshal_trading_books is keyed by a single book_id whose value is the one this schedule pinned — there is no enumerating read to widen.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import crypto from 'crypto';
import {
  ensureLegacyBooks, legacyBookId, createBook, updateBook, listBooks, recordArmAck,
  requiresArmAcknowledgement, armAcknowledged, loadBook,
} from '../../src/app/trading-books-store';
import { accountDigest } from '../../src/app/trading-accounts-store';
import { dispatchTradingSchedule } from '../../src/app/trading-schedule-dispatch';
import type { AppContext } from '../../src/app/composition/app-context';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { ensureTradingSpecSchema } from '../helpers/trading-spec-schema';

// Its OWN server, never an address: trading specs pointed at the operator's live Postgres twice on
// 2026-09-14, and this file both reads and WRITES books for a dispatch that is one env flag away
// from a real order path.
const fixture = new DisposablePostgres({
  purpose: 'trading-arm-acknowledgement',
  options: '-c row_security=off',
  max: 4,
});
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-armack-${RUN}`;

let pool: Pool;
let bookA = '';
let bookB = '';

/** Every statement one dispatch executed, in order, so a guard can assert on the SQL itself. */
interface SeenQuery { text: string; values: unknown[] }

/**
 * @description An AppContext whose pool records every statement before delegating to the real one.
 * The recording is what makes "this fire never enumerated the user's books" an observation rather
 * than an inference — the mutation that reintroduces the defect is an enumerating read, and it
 * shows up here as a statement with no book_id predicate.
 * @param seen - Array the spy appends to.
 * @returns A context usable by dispatchTradingSchedule.
 */
function spyCtx(seen: SeenQuery[]): AppContext {
  // A Proxy over the REAL pool, not a stand-in for it: everything but `query` passes straight
  // through, so a caller that reaches for connect()/end() gets the genuine client.
  const spy = new Proxy(pool, {
    get(target, prop, recv) {
      if (prop !== 'query') return Reflect.get(target, prop, recv);
      return (text: unknown, values?: unknown[]) => {
        seen.push({ text: typeof text === 'string' ? text : String((text as { text?: string })?.text ?? ''), values: values ?? [] });
        return (target.query as (t: unknown, v?: unknown[]) => unknown)(text, values);
      };
    },
  });
  return { pool: spy, ticketService: { createTicket: async () => ({}) } } as unknown as AppContext;
}

const ctx = () => ({ pool, ticketService: { createTicket: async () => ({}) } } as unknown as AppContext);

/** A due autopilot schedule pinned to one book (or to none, which is the legacy first leg). */
const schedule = (bookId: string | null) => ({
  id: `spec-armack-${RUN}`,
  taskType: 'trading-autopilot',
  taskData: { userSub: SUB, mode: 'live', ...(bookId ? { bookId } : {}) },
}) as never;

/**
 * @description Seed a discovered Schwab account through the REAL envelope path, so loadBook's
 * decrypt is exercised rather than side-stepped.
 * @param last - A digit making this account's number distinct from its siblings'.
 * @returns The account id.
 */
async function seedAccount(last: string): Promise<string> {
  const num = `9${RUN}${last}`;
  const { encryptToken } = await import('../../src/app/routes/connector-token-crypto');
  const enc = await encryptToken(pool as never, SUB, num);
  const r = await pool.query(
    `INSERT INTO oshal_trading_accounts (user_sub, broker, connection_key, account_number_enc, account_digest, account_last4)
       VALUES ($1,'schwab','default',$2,$3,$4) RETURNING account_id`,
    [SUB, enc, accountDigest(SUB, num), num.slice(-4)]);
  return String(r.rows[0].account_id);
}

beforeAll(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || `spec-secret-${RUN}`;
  pool = await fixture.start();
  await ensureTradingSpecSchema(pool);
  await ensureLegacyBooks(pool as never, SUB);
  // Two SECOND books, both bound to accounts of their own, both turned ON. Enabling is the act the
  // entry says is inert for trading; these rows are what makes that claim testable.
  const a = await createBook(pool as never, SUB, await seedAccount('1'), 'Rollover (spec)');
  const b = await createBook(pool as never, SUB, await seedAccount('2'), 'Joint (spec)');
  bookA = a.bookId; bookB = b.bookId;
  await updateBook(pool as never, SUB, bookA, { enabled: true });
  await updateBook(pool as never, SUB, bookB, { enabled: true });
}, 180_000);

afterAll(async () => {
  await pool.query(`DELETE FROM oshal_trading_books WHERE user_sub LIKE 'spec-armack-%'`).catch(() => {});
  await pool.query(`DELETE FROM oshal_trading_accounts WHERE user_sub LIKE 'spec-armack-%'`).catch(() => {});
  await fixture.stop();
});

beforeEach(() => {
  // The multi-account branch is the one under test; the live double-opt-in stays OFF so the fire
  // that gets PAST the arming gate stops at a refusal we can name instead of reaching a venue.
  process.env.TRADING_MULTI_ACCOUNT = 'true';
  delete process.env.TRADING_LIVE_ENABLED;
  delete process.env.TRADING_AUTOPILOT_LIVE;
});

describe('which books carry the arming gate', () => {
  it('the two legacy books do not; a second book does', async () => {
    const books = await listBooks(pool as never, SUB);
    const legacy = books.filter((b) => b.ref === 'paper' || b.ref === 'live');
    expect(legacy).toHaveLength(2);
    for (const b of legacy) {
      expect(requiresArmAcknowledgement(b), `${b.ref} must not carry the gate`).toBe(false);
      expect(armAcknowledged(b)).toBe(true);
    }
    const second = books.filter((b) => b.ref.startsWith('b-'));
    expect(second.length).toBeGreaterThanOrEqual(2);
    for (const b of second) expect(requiresArmAcknowledgement(b), `${b.ref} must carry the gate`).toBe(true);
  });
});

describe('arming a leg for a second book needs an acknowledgement recorded against that book', () => {
  it('enabled but unacknowledged → the fire is a hard-skip; the acknowledgement is what lets it through', async () => {
    // The book is ENABLED. Nothing else about it changes across these three fires.
    expect((await loadBook(pool as never, SUB, bookA))?.enabled).toBe(true);

    await recordArmAck(pool as never, SUB, bookA, false, SUB);
    const blocked = await dispatchTradingSchedule(ctx(), schedule(bookA));
    expect(blocked.success).toBe(true);                         // a logged no-op, like its sibling hard-skips
    expect((blocked as { error?: string }).error).toBeUndefined();
    expect((blocked as { taskId?: string }).taskId).toBeUndefined();

    const acked = await recordArmAck(pool as never, SUB, bookA, true, SUB, 'spec: operator read the arming copy');
    expect(acked?.armAckAt).toBeTruthy();
    expect(acked?.armAckBy).toBe(SUB);

    // Same schedule, same book, same enabled flag — now it reaches the ordinary live gate, which is
    // the first thing PAST the arming gate. Only the acknowledgement row changed.
    const through = await dispatchTradingSchedule(ctx(), schedule(bookA));
    expect(through.success).toBe(false);
    expect(String((through as { error?: string }).error)).toMatch(/autopilot live is disabled/);
  });

  it('withdrawing the acknowledgement puts the hard-skip back', async () => {
    await recordArmAck(pool as never, SUB, bookA, true, SUB);
    const withdrawn = await recordArmAck(pool as never, SUB, bookA, false, SUB);
    expect(withdrawn?.armAckAt).toBeNull();
    expect(withdrawn?.armAckBy).toBeNull();
    const r = await dispatchTradingSchedule(ctx(), schedule(bookA));
    expect(r.success).toBe(true);
    expect((r as { error?: string }).error).toBeUndefined();
  });

  it('the acknowledgement is recorded against ONE book, not the user', async () => {
    await recordArmAck(pool as never, SUB, bookA, true, SUB);
    await recordArmAck(pool as never, SUB, bookB, false, SUB);
    const b = await dispatchTradingSchedule(ctx(), schedule(bookB));
    expect(b.success).toBe(true);
    expect((b as { error?: string }).error).toBeUndefined();
    const a = await dispatchTradingSchedule(ctx(), schedule(bookA));
    expect(String((a as { error?: string }).error)).toMatch(/autopilot live is disabled/);
  });

  it('the legacy first leg never asks for one — it fires exactly as it does today', async () => {
    const r = await dispatchTradingSchedule(ctx(), schedule(null));
    expect(r.success).toBe(false);
    expect(String((r as { error?: string }).error)).toMatch(/autopilot live is disabled/);
  });
});

describe('`enabled` alone never widens the set of books a schedule dispatches', () => {
  it('four enabled books on the user; one fire reads exactly the one book its schedule pinned', async () => {
    await recordArmAck(pool as never, SUB, bookA, true, SUB);
    await recordArmAck(pool as never, SUB, bookB, true, SUB);
    const enabled = (await listBooks(pool as never, SUB)).filter((b) => b.enabled);
    expect(enabled.length, 'the premise: several books are enabled at once').toBeGreaterThanOrEqual(4);

    const seen: SeenQuery[] = [];
    await dispatchTradingSchedule(spyCtx(seen), schedule(bookA));

    // Reads of the books table only — the schema rail's DDL / mint block is not a read decision.
    const reads = seen.filter((q) => /oshal_trading_books/i.test(q.text)
      && /^\s*SELECT/i.test(q.text)
      && !/INSERT\s+INTO|CREATE\s|ALTER\s|DROP\s|DO\s*\$\$/i.test(q.text));
    expect(reads.length, 'a fire must read the books table at least once').toBeGreaterThan(0);

    for (const q of reads) {
      // Every read is keyed by ONE book id. An enumerating read ("all enabled books for this user")
      // has no such predicate, which is exactly how the defect would show up here.
      expect(q.text, `unkeyed read of oshal_trading_books:\n${q.text}`).toMatch(/book_id\s*=\s*\$2/);
    }
    const idsRead = new Set(reads.map((q) => String(q.values[1])));
    expect([...idsRead], 'the fire touched a book other than the one its schedule pinned').toEqual([bookA]);
    expect(idsRead.has(bookB)).toBe(false);
    expect(idsRead.has(legacyBookId(SUB, 'live'))).toBe(false);
    expect(idsRead.has(legacyBookId(SUB, 'paper'))).toBe(false);
  });
});
