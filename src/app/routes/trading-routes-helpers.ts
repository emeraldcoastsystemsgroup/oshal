/**
 * Shared request + guardrail helpers for the trading route modules (ADR-052).
 * Leaf module — imported by trading-routes.ts and every trading-routes-* sibling;
 * imports nothing from them, so it can never participate in an import cycle.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from trading-routes.ts (1000-line cap decomposition): callerSub, resolveMode, servePage, the guardrails (Guardrails/guardrails/guardrailViolation), TradingError, and the SignalRow shape. Code moved verbatim — zero behavior change.
 *
 * @module trading-routes-helpers
 */

import type { Request, RequestHandler } from 'express';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';
import { getTrustedServiceUserSub } from '@/shared/middleware/authz';
// CHANGE LOG addendum (ADR-134 PR1): resolveBook joins resolveMode — the kernel choke-point that
// maps a route's `book` (or legacy `mode`) param to a TradingBook. Garbage refs are a 400, never a
// silent remap to paper (a typo'd live protective action must not become a paper no-op with a 200).
import type { TradingBook, TradingMode } from '@/features/trading';

// Same module tag as the entry file so structured log output is unchanged by the split.
const logger = createChildLogger({ module: 'trading-routes' });

/**
 * @description Signed-in caller's OIDC sub, or the trusted sub from an internal service-secret call
 * (X-Service-Secret + X-OSHAL-User-Sub) so the trading_* operator tools / Jarvis can drive
 * the book on the user's behalf. Same precedence as eats/rides/spotify/purchasing.
 * @param req - The incoming Express request.
 * @returns The acting user's sub, or null when the caller is unauthenticated.
 */
export function callerSub(req: Request): string | null {
  const trusted = getTrustedServiceUserSub(req);
  if (trusted) return trusted;
  const u = (req as { oidc?: { user?: { sub?: string; oid?: string } } }).oidc?.user;
  const sub = u?.sub || u?.oid;
  return sub ? String(sub) : null;
}

/**
 * @description Resolve and validate the requested book; defaults to the safe 'paper'.
 * @param raw - The raw mode value from a query/body field.
 * @returns 'live' only on an explicit request; otherwise 'paper'.
 */
export function resolveMode(raw: unknown): TradingMode {
  return String(raw || '').toLowerCase() === 'live' ? 'live' : 'paper';
}

/**
 * @description Resolve a route's `book` (or legacy `mode`) parameter to a TradingBook (ADR-134).
 * Accepts the alias literals 'paper'/'live' (→ the legacy books), a book ref ('b-xxxxxxxx'), or a
 * book UUID. A GARBAGE ref is a 400, never a remap — silently collapsing a typo'd `&book=` on a
 * live order/exit route to the paper book would turn an intended real-money protective action into
 * a paper no-op with a 200 (adversarial-review rule). Absent/empty raw defaults to legacy paper,
 * exactly like resolveMode.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param raw - The raw `book` (or `mode`) value from a query/body field.
 * @returns The resolved TradingBook.
 * @throws TradingError 400 on an unknown/foreign ref; 404-shaped refusal stays a 400 to avoid
 *   existence probing across users.
 */
export async function resolveBook(pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, sub: string, raw: unknown): Promise<TradingBook> {
  const { legacyBook, legacyBookId, loadBook, getBookByRef } = await import('../trading-books-store.js');
  const v = String(raw ?? '').trim().toLowerCase();
  // ALIASES RESOLVE THROUGH THE DB ROW (surface-audit finding 2026-09-03): the pure legacyBook()
  // constructor hard-codes enabled:true, so alias-addressed routes ignored a legacy book the
  // operator had set to view-only — "Stop trading" showed on screen while route-driven buys still
  // executed. The row carries the real enabled/capital-cap/binding; the pure constructor remains
  // only the bootstrap fallback for a user whose books were never minted.
  if (!v || v === 'paper' || v === 'live') {
    const kind = (v === 'live' ? 'live' : 'paper') as 'paper' | 'live';
    const row = await loadBook(pool as never, sub, legacyBookId(sub, kind)).catch(() => null);
    return row ?? legacyBook(sub, kind);
  }
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const book = isUuid ? await loadBook(pool as never, sub, v) : await getBookByRef(pool as never, sub, String(raw).trim());
  if (!book) throw new TradingError(400, 'unknown_book', `No such trading book '${String(raw).trim()}' for this user.`);
  return book;
}

/**
 * @description Serve a static surface file from the api dir.
 * @param apiDir - Directory holding the HTML surface.
 * @param file - File name within apiDir.
 * @returns An Express handler that sends the file (404 + log on failure).
 */
export function servePage(apiDir: string, file: string): RequestHandler {
  return (_req, res) => {
    res.sendFile(path.join(apiDir, file), (err) => {
      if (err) { logger.error({ err, file }, 'serve trading surface failed'); res.status(404).send('Not found'); }
    });
  };
}

/* ─── guardrails (ADR-052 open-question defaults; env-overridable) ─────────────── */

/** The order-size limits every trade must respect (ADR-052). */
export interface Guardrails {
  maxQty: number;
  maxNotionalUsd: number;
  allowList: string[];   // empty = all symbols allowed
}

/**
 * @description The active guardrails, read from env with the ADR-052 defaults.
 * @returns Max share count, max order notional, and the symbol allow-list.
 */
export function guardrails(): Guardrails {
  const allow = (process.env.TRADING_SYMBOL_ALLOWLIST || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return {
    maxQty: Number(process.env.TRADING_MAX_QTY || 100),
    maxNotionalUsd: Number(process.env.TRADING_MAX_NOTIONAL_USD || 1000),
    allowList: allow,
  };
}

/**
 * @description Apply guardrails to a proposed order.
 * @param g - The active guardrails.
 * @param symbol - Proposed symbol.
 * @param qty - Proposed share count.
 * @param refPrice - Reference price for the notional check (0/negative skips that check).
 * @returns A reason string if the order should be blocked, else null.
 */
export function guardrailViolation(g: Guardrails, symbol: string, qty: number, refPrice: number): string | null {
  if (g.allowList.length && !g.allowList.includes(symbol.toUpperCase())) {
    return `${symbol} is not on the trading allow-list (${g.allowList.join(', ')}).`;
  }
  if (qty > g.maxQty) return `qty ${qty} exceeds the max of ${g.maxQty} shares.`;
  const notional = qty * (refPrice > 0 ? refPrice : 0);
  if (refPrice > 0 && notional > g.maxNotionalUsd) {
    return `order notional ~$${notional.toFixed(0)} exceeds the max of $${g.maxNotionalUsd}.`;
  }
  return null;
}

/**
 * @description A trading-flow refusal carrying the HTTP status + machine code the route should return.
 */
export class TradingError extends Error {
  constructor(public httpStatus: number, public code: string, message: string) { super(message); }
}

/** A captured signal row as handed to the bot / surface. */
export interface SignalRow {
  signal_id: string; source: string; author: string | null; title: string | null;
  body: string | null; url: string | null; symbols: string[] | null; indicators: unknown;
  observed_at: string;
}
