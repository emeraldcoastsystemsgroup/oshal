/**
 * Ledger / money-anomaly monitor — Security Center (ADR-055).
 *
 * Watches the money-moving apps' ledgers (the trading orders from ADR-052 and the shop purchase
 * history) for the caller's own books and flags entries worth a second look: live-mode trades,
 * large-notional orders, a reject-rate spike, an order with no justifying decision (the ADR-052
 * invariant — should be impossible via FK, so a hit here is a real integrity alarm), and large
 * purchases. Owner-scoped: it only reads the signed-in operator's rows.
 *
 * @module features/security/ledger-monitor
 */

import { createChildLogger } from '@/shared/logger';
import type { Pool } from 'pg';
import type { RawFinding, ScannerReport } from './types';
import { tableExists } from './db-utils';

const logger = createChildLogger({ module: 'security:ledger-monitor' });

const num = (env: string, def: number) => Number(process.env[env] || def);

export async function monitorLedgers(pool: Pool, sub: string): Promise<ScannerReport> {
  const findings: RawFinding[] = [];
  const notes: string[] = [];
  const bigOrderUsd = num('SECURITY_BIG_ORDER_USD', 2000);
  const bigPurchaseUsd = num('SECURITY_BIG_PURCHASE_USD', 1000);
  let scanned = false;

  try {
    // ── Trading ledger ──────────────────────────────────────────────────────
    if (await tableExists(pool, 'oshal_trading_orders')) {
      scanned = true;
      // a) Order with no justifying decision — violates the ADR-052 invariant.
      const orphan = (await pool.query(
        `SELECT order_id, symbol, side, qty, mode FROM oshal_trading_orders
          WHERE user_sub = $1 AND decision_id IS NULL LIMIT 25`, [sub])).rows;
      for (const o of orphan) {
        findings.push({
          category: 'ledger',
          severity: 'critical',
          title: `Unjustified ${o.mode} order ${o.symbol} (no decision)`,
          detail: `Order ${o.order_id} (${o.side} ${o.qty} ${o.symbol}, ${o.mode}) has no linked decision. Every order must trace to a signal-justified decision (ADR-052); a null decision means the provenance chain is broken — investigate how it was created.`,
          source: `oshal_trading_orders:${o.order_id}`,
          evidence: { orderId: o.order_id, symbol: o.symbol, side: o.side, qty: o.qty, mode: o.mode },
          fingerprint: `ledger:orphan-order:${o.order_id}`,
        });
      }

      // b) Large-notional orders (filled value above threshold).
      const big = (await pool.query(
        `SELECT order_id, symbol, side, qty, mode, filled_avg_price, filled_qty, created_at
           FROM oshal_trading_orders
          WHERE user_sub = $1 AND filled_avg_price IS NOT NULL
            AND (COALESCE(filled_qty,qty) * filled_avg_price) > $2
          ORDER BY (COALESCE(filled_qty,qty) * filled_avg_price) DESC LIMIT 15`, [sub, bigOrderUsd])).rows;
      for (const o of big) {
        const notional = Number(o.filled_avg_price) * Number(o.filled_qty ?? o.qty);
        findings.push({
          category: 'ledger',
          severity: o.mode === 'live' ? 'high' : 'low',
          title: `Large ${o.mode} order: ${o.symbol} ~$${notional.toFixed(0)}`,
          detail: `A ${o.mode} ${o.side} of ${o.symbol} executed at ~$${notional.toFixed(0)} notional (threshold $${bigOrderUsd}). ${o.mode === 'live' ? 'This is real money — confirm it was intended.' : 'Paper book — informational.'}`,
          source: `oshal_trading_orders:${o.order_id}`,
          evidence: { orderId: o.order_id, symbol: o.symbol, side: o.side, mode: o.mode, notionalUsd: Math.round(notional), at: o.created_at },
          fingerprint: `ledger:big-order:${o.order_id}`,
        });
      }

      // c) Reject-rate spike in the last 24h.
      const rej = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM oshal_trading_orders
          WHERE user_sub = $1 AND status IN ('rejected','canceled','cancelled')
            AND created_at > now() - interval '24 hours'`, [sub])).rows[0]?.n ?? 0;
      if (rej >= num('SECURITY_REJECT_THRESHOLD', 5)) {
        findings.push({
          category: 'ledger',
          severity: 'medium',
          title: `${rej} rejected/canceled orders in 24h`,
          detail: `${rej} trading orders were rejected or canceled in the last 24 hours. A reject spike can indicate guardrail thrash, a broker problem, or automated misbehavior.`,
          source: 'oshal_trading_orders',
          evidence: { rejected24h: rej },
          fingerprint: 'ledger:reject-spike-24h',
        });
      }
    } else {
      notes.push('trading ledger not present');
    }

    // ── Shop purchase history ───────────────────────────────────────────────
    if (await tableExists(pool, 'shop_purchase_history')) {
      scanned = true;
      const big = (await pool.query(
        `SELECT purchase_id, retailer, total, created_at FROM shop_purchase_history
          WHERE user_sub = $1 AND total > $2 ORDER BY total DESC LIMIT 15`, [sub, bigPurchaseUsd])).rows;
      for (const p of big) {
        findings.push({
          category: 'ledger',
          severity: 'medium',
          title: `Large purchase: $${Number(p.total).toFixed(2)} (${p.retailer || 'retailer'})`,
          detail: `A purchase handoff of $${Number(p.total).toFixed(2)} at ${p.retailer || 'a retailer'} exceeds the $${bigPurchaseUsd} watch threshold. Confirm it was intended.`,
          source: `shop_purchase_history:${p.purchase_id}`,
          evidence: { purchaseId: p.purchase_id, retailer: p.retailer, totalUsd: Number(p.total), at: p.created_at },
          fingerprint: `ledger:big-purchase:${p.purchase_id}`,
        });
      }
    } else {
      notes.push('shop history not present');
    }
  } catch (err) {
    logger.error({ err }, 'ledger monitor failed');
    return { kind: 'ledger', available: scanned, findings, note: `ledger monitor error: ${(err as Error).message}` };
  }

  return {
    kind: 'ledger',
    available: scanned,
    findings,
    note: scanned ? `ledger scan (${findings.length} hit(s))${notes.length ? '; ' + notes.join(', ') : ''}` : notes.join(', ') || 'no ledgers present',
  };
}
