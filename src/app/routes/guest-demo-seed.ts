/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guest demo seed (Phase 2). On guest session start, plant a believable shared fake finance account for the new per-browser guest sub so the (read-only) Finance app shows data instead of an empty state. Idempotent + best-effort; never blocks login. Matches FinanceAggregate (finance-plaid.ts).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | RLS fix + demo tickets. The seed ran on the bare pool with no oshal.current_sub GUC, so FORCE-RLS rejected every insert ("new row violates row-level security policy") and every guest since launch got ZERO data — the catch swallowed it as designed. All seeding now runs in one transaction with transaction-local set_config to the guest sub. Also seeds three demo tickets (owner_sub = guest) so the cockpit's core surfaces show real-looking content; statuses are deliberately queue-inert (complete/backlog — never approved/in_process, which the queue manager would dispatch to bots and spend LLM on).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1 carve #5: oshal_finance_items/data are now PACKAGE-owned tables (finance carved to the store; their lazy DDL lives in the package's finance-plaid route). This seed stays kernel-side deliberately — guest sessions are a framework concern — and is already skip-if-absent: when the finance package isn't installed the tables don't exist, the catch below no-ops, and the Finance surface (also package-served) isn't reachable anyway. No functional change.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Savepoint-fence the finance seed inside the new single-transaction shape: with everything in one txn, a missing finance package (carve #5 above) would have aborted the WHOLE transaction and rolled the demo tickets back too. Finance failure now rolls back to its savepoint and the tickets still commit.
 */

import crypto from 'crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'guest-demo-seed' });

const DEMO_INSTITUTION = 'Emerald Coast Bank (Demo)';

/** A static, believable finance aggregate every guest sees (read-only). */
function demoFinanceAggregate(): unknown {
  const accounts = [
    { name: 'Everyday Checking', type: 'depository', subtype: 'checking', mask: '4021', balance: 8432.17, currency: 'USD', institution: DEMO_INSTITUTION },
    { name: 'High-Yield Savings', type: 'depository', subtype: 'savings', mask: '7788', balance: 24190.55, currency: 'USD', institution: DEMO_INSTITUTION },
    { name: 'Rewards Credit Card', type: 'credit', subtype: 'credit card', mask: '1199', balance: -1284.42, currency: 'USD', institution: DEMO_INSTITUTION },
    { name: 'Brokerage', type: 'investment', subtype: 'brokerage', mask: '3050', balance: 61740.0, currency: 'USD', institution: DEMO_INSTITUTION },
  ];
  const holdings = [
    { name: 'Vanguard Total Stock Market ETF', ticker: 'VTI', type: 'etf', quantity: 120, value: 33600, costBasis: 27800, institution: DEMO_INSTITUTION, accountName: 'Brokerage' },
    { name: 'Apple Inc.', ticker: 'AAPL', type: 'equity', quantity: 60, value: 13140, costBasis: 9900, institution: DEMO_INSTITUTION, accountName: 'Brokerage' },
    { name: 'US Treasury Money Market', ticker: null, type: 'cash', quantity: 15000, value: 15000, costBasis: 15000, institution: DEMO_INSTITUTION, accountName: 'Brokerage' },
  ];
  return {
    generatedAt: '2026-06-01T12:00:00.000Z',
    currency: 'USD',
    netWorth: { assets: 8432.17 + 24190.55 + 61740.0, liabilities: 1284.42, net: 8432.17 + 24190.55 + 61740.0 - 1284.42 },
    accounts,
    holdings,
    topSpending: [
      { category: 'Groceries', total: 612.38, count: 14 },
      { category: 'Dining', total: 388.1, count: 11 },
      { category: 'Transport', total: 210.45, count: 8 },
    ],
    spendByMonth: [
      { month: '2026-04', spend: 3120.55, income: 6400 },
      { month: '2026-05', spend: 2890.12, income: 6400 },
    ],
    recentTransactions: [
      { date: '2026-05-29', name: 'Publix', amount: 84.22, category: 'Groceries' },
      { date: '2026-05-28', name: 'Shell', amount: 41.6, category: 'Transport' },
      { date: '2026-05-27', name: 'Local Diner', amount: 36.5, category: 'Dining' },
    ],
    transactionWindowDays: 60,
    notes: ['Demo data — not a real account.'],
  };
}

const DEMO_BRIEF =
  'Demo snapshot: about $94.4k in assets across checking, savings, and a brokerage, against ' +
  '$1.3k of card balance. Cash is healthy; the brokerage is roughly 70% equities. This is sample ' +
  'data for the guest preview, not real financial advice.';

/**
 * Demo tickets every fresh guest sees in the cockpit's core surfaces (Tickets,
 * Dashboard, ticket detail). Statuses are queue-INERT on purpose: `complete` is
 * finished work and `backlog` is parked — the queue manager only dispatches
 * approved/in-flight work, so a seeded ticket can never reach a bot or spend LLM.
 */
function demoTickets(): Array<{ title: string; description: string; ticketType: string; status: string; stateGroup: string; priority: string; labels: string[] }> {
  return [
    {
      title: 'Demo: checkout latency spike after 14:00 deploy',
      description: 'RESOLVED (sample data). Root cause: connection pool exhaustion after the 14:00 rollout doubled worker concurrency without raising max_connections. Fix applied: pool cap raised 20→50 and rollout gated on a p95 latency probe. Timeline, evidence, and remediation steps were produced by the incident-rca workflow; this copy is planted for the guest tour — no real system was involved.',
      ticketType: 'incident-rca',
      status: 'complete',
      stateGroup: 'complete',
      priority: 'high',
      labels: ['demo', 'incident'],
    },
    {
      title: 'Demo: add CSV export to the orders report',
      description: 'COMPLETED (sample data). A build ticket the swarm carried end-to-end: worker bot implemented the export endpoint + UI button, self-gated with the persona quality checklist, and shipped artifacts including HANDOVER.md. Planted for the guest tour.',
      ticketType: 'build',
      status: 'complete',
      stateGroup: 'complete',
      priority: 'medium',
      labels: ['demo', 'feature'],
    },
    {
      title: 'Demo: draft Q3 supplier-comparison brief',
      description: 'BACKLOG (sample data). Parked work item showing the intake side: tickets land here until an operator approves them into the queue. Approve-to-dispatch is disabled for guest sessions.',
      ticketType: 'build',
      status: 'backlog',
      stateGroup: 'backlog',
      priority: 'low',
      labels: ['demo'],
    },
    {
      // The Tickets view defaults to the "Active" filter (state_group not complete/
      // cancelled), which would hide both completed stories above — this row keeps the
      // guest's FIRST view populated. customer_action is queue-inert: the poll loop only
      // dispatches `approved`, and the orphan sweeps only touch in_process_* states.
      title: 'Demo: onboarding email sequence — awaiting your tone pick',
      description: 'WAITING ON YOU (sample data). The human-in-the-loop side: the worker bot drafted two variants of a customer onboarding sequence (friendly vs. formal) and paused for a decision rather than guessing. Replying is disabled for guest sessions.',
      ticketType: 'build',
      status: 'customer_action',
      stateGroup: 'customer_action',
      priority: 'medium',
      labels: ['demo', 'needs-input'],
    },
  ];
}

/**
 * @description Seeds per-guest demo data (finance snapshot + three queue-inert
 * tickets) for a fresh guest sub. Runs in ONE transaction with a transaction-local
 * `oshal.current_sub` GUC — the tables are FORCE-RLS, so without the GUC every
 * insert is rejected (which is exactly how this seed silently failed for every
 * guest until 2026-07-18). Best-effort: any failure rolls back, logs, and never
 * blocks the guest from getting into the cockpit.
 */
export async function seedGuestDemoData(pool: Pool, sub: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Transaction-local identity: RLS policies key on oshal.current_sub.
    await client.query("SELECT set_config('oshal.current_sub', $1, true), set_config('oshal.is_operator', 'off', true)", [sub]);

    for (const t of demoTickets()) {
      await client.query(
        `INSERT INTO tickets (ticket_id, title, description, ticket_type, status, state_group, priority, labels, owner_sub, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [crypto.randomUUID(), t.title, t.description, t.ticketType, t.status, t.stateGroup, t.priority, t.labels, sub, JSON.stringify({ demo: true, source: 'guest-demo-seed' })],
      );
    }

    // Finance tables are PACKAGE-owned (ADR-085 carve #5) and may not exist on this
    // host. Savepoint-fence them so a missing package can never roll the tickets back.
    await client.query('SAVEPOINT finance_seed');
    try {
      await client.query(
        `INSERT INTO oshal_finance_items (item_id, user_sub, institution, access_token)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (item_id) DO NOTHING`,
        [`guest-demo-${sub}`, sub, DEMO_INSTITUTION, 'guest-demo-no-token'],
      );
      await client.query(
        `INSERT INTO oshal_finance_data (user_sub, aggregate, brief, synced_at, brief_at)
         VALUES ($1, $2::jsonb, $3, now(), now())
         ON CONFLICT (user_sub) DO NOTHING`,
        [sub, JSON.stringify(demoFinanceAggregate()), DEMO_BRIEF],
      );
    } catch (financeErr) {
      await client.query('ROLLBACK TO SAVEPOINT finance_seed');
      logger.info({ err: (financeErr as Error).message, sub }, 'Guest finance seed skipped (package absent?) — tickets kept');
    }

    await client.query('COMMIT');
    logger.info({ sub }, 'Seeded guest demo data (tickets + finance)');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Non-fatal — worst case the guest sees empty states, never a blocked login.
    logger.warn({ err: (err as Error).message, sub }, 'Guest demo seed skipped (non-fatal)');
  } finally {
    client.release();
  }
}
