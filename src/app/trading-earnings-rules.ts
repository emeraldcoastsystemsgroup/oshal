/**
 * Earnings-reaction rules (ADR-136 D5) — the KERNEL half. An operator arms ONE standing rule per
 * (book, symbol): "when this name reports, act on what it actually filed". The rule is a small state
 * machine that rides the existing per-user `trading-events` leg (the same cadence and the same
 * TRADING_EVENT_PLANS gate as event playbooks, protected lots and dated orders):
 *
 *   armed ─(an 8-K carrying item 2.02, accepted inside the earnings window)→ detected
 *   detected ─(its primary document read by the accountable trading-analyst)→ classified
 *   classified ─(the mapped action + the first regular-session print agreeing)→ fired
 *   classified ─(mapped to hold | verdict unclear | the print disagrees past the act window)→ no_action
 *   classified ─(shares already moved, but the rule stops before its whole intent)→ fired_short
 *   any ─(operator disarms)→ cancelled | (expiry reached)→ expired | (invariant broken)→ error
 *
 * `fired` means the intent COMPLETED. `fired_short` means shares moved and the intent did NOT — the
 * only honest status for a rule that sold 264 of 1000 and then stopped. `no_action` is reserved for a
 * rule that never moved a share; once one has, calling it "no action" is a lie the operator would act
 * on. Every terminal write goes through {@link closeRule}, which is what makes that invariant hold at
 * EVERY exit (expiry, a vanished book, a stale verdict, a faded reaction, a refusal) rather than only
 * at the two the truncation path happened to think about.
 *
 * WHAT "BEAT" AND "MISS" MEAN HERE: the company's OWN filed numbers versus the prior-year period and
 * versus its OWN prior guidance — never Street consensus. oshal ingests no consensus-estimate feed, so
 * a rule that claimed to read one would be lying to the operator. That sentence is
 * {@link CLASSIFICATION_BASIS}: it goes into the analyst's prompt AND verbatim into the decision
 * rationale, so it is visible in the journal everywhere the trade is reviewed.
 *
 * SCOPE, deliberately narrow: only symbols HELD on the book, only inside the earnings window (the
 * rule's expected date ± the window knobs, or the world calendar's days-to-earnings), one EDGAR
 * submissions read per held symbol per tick. Never a market-wide crawl.
 *
 * THE ORDER PATH: one `deps.place` → `placeDecisionOrder` call per tranche, one requestId per tranche.
 * The engine's reservation arbiter does NOT make a retry a no-op after a failure — read its catch:
 * `DELETE FROM oshal_trading_orders … AND status='submitting'` releases the claim on the way out, so
 * the same requestId submits again for real. That is why the ambiguous-failure path below settles with
 * the venue instead of trusting the arbiter. TWO guards live HERE because the engine does not cross
 * them for this shape of order — verified in the code, not assumed:
 *   • TRADING_HALT — `placeDecisionOrder` never reads it (only the strategy legs and
 *     `tradableSession*` do), so the panic button is honoured in {@link fireRule} or not at all.
 *   • the notional ceiling — `guardrailViolation` skips the notional test when refPrice is 0, and
 *     refPrice is `limitPrice ?? stopPrice ?? 0`, i.e. 0 for a MARKET order. So the rule sizes itself
 *     against TRADING_MAX_NOTIONAL_USD in {@link sizeRuleOrder} AND fires a marketable LIMIT (the last
 *     print × (1 ± TRADING_EARNINGS_RULE_SLIPPAGE_PCT), day, regular session only) so the engine's own
 *     notional check applies as well. Belt and braces, because this can be live money — and the belt is
 *     sized against the LIMIT the order will carry, never the last print: the engine re-checks at
 *     `refPrice = limit_price`, so sizing against the (lower, for a buy) print would mint the one order
 *     the engine then refuses at exactly the cap, and that refusal would be terminal.
 *
 * A REFUSAL IS NOT ALWAYS FINAL: a 4xx from `placeDecisionOrder` is a decision about THIS order
 * (book_disabled, guardrail_blocked, not_actionable, duplicate_submission) and ends the rule. A 5xx is
 * the rail being briefly unavailable (`broker_not_configured` on a token-refresh blip,
 * `settlement_unknown` when the account read fails) — both are thrown BEFORE any venue submission and
 * release the reservation, so the rule keeps its action and retries on the next tick under the same
 * requestId. Making that terminal would silently disarm the PROTECTIVE miss→sell half. An UNKNOWN
 * failure (a broker adapter throwing a plain Error, a hangup after the venue accepted) is neither
 * — it is UNKNOWN, not failed, and a blanket retry of an unknown is how one intent becomes two real
 * fills. So the rule does not guess: {@link settleAtVenue} asks the venue's OWN order record what
 * happened ({@link EarningsRuleDeps.listOrders} over a ±TRADING_EARNINGS_RULE_VENUE_LOOKBACK_MIN
 * window, matched on symbol/side/qty — the same authority and the same predicate `rebindOrder` uses),
 * and only then decides, SIDE-AWARE:
 *   • the venue HAS a matching order → nothing is re-placed. It is ADOPTED into the rule's order state
 *     (placedQty, a tranche marked `adopted`) so the ledger and the rule agree and the sell continues
 *     from where it actually is.
 *   • the venue positively has NOTHING and the side is SELL → the submission never landed, so a retry
 *     adds no fill: retry, bounded per RULE by TRADING_EARNINGS_RULE_MAX_PLACE_ATTEMPTS. A protective
 *     exit that stops half-done is the harm this feature exists to prevent, and an oversell is walled
 *     off twice over (`remaining` is capped by the CURRENT held quantity, and a working duplicate would
 *     have been seen by the enumeration above).
 *   • the side is BUY → never re-placed, even on a clean "nothing there". A missed entry costs an
 *     opportunity; a duplicate buy costs real capital the operator never asked for, and this module
 *     deliberately does not repeat buys at all. Venue enumeration can also lag a just-entered order,
 *     and that race must resolve toward the cheaper mistake.
 *   • the venue could not be asked (no enumeration, an error, or more than one match) → nothing is
 *     re-placed on either side. The rule stops loudly naming the ambiguity.
 *
 * A TRUNCATED ACTION IS NEVER SILENT, AND NEITHER IS A STAND-DOWN AFTER ONE: the fleet guardrails cap
 * what ONE order may carry, and on the deployed defaults that cap is far below a whole position.
 * "Sell 100%" of a position larger than the cap is therefore placed in TRANCHES across following ticks
 * (the intent is fixed at the first fire, so an unfilled tranche can never become an oversell). A rule
 * that ends short of its intent — for ANY reason: the guardrail cap, the tranche bound, a stale verdict,
 * a faded reaction, an expiry, a refusal — ends `fired_short`, with `truncated`, a `shortReason`, the
 * shares left exposed named on its timeline, and a WARN in the log.
 *
 * The fired decision's agent_id is 'event-rule', which is deliberately NOT in the engine's
 * operator-authored allowlist: a rule fires with no human present at the moment of the trade, which is
 * exactly the autopilot-shaped risk a view-only book means to refuse. A beat→BUY on a disabled book is
 * therefore refused (`book_disabled`) and recorded as `error` with that reason; a miss→SELL is never
 * refused. The whole feature is off unless TRADING_EARNINGS_RULES=true AND TRADING_EVENT_PLANS=true.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Fix round 4, two live-money holes: (a) a tranched protective sell could end SILENTLY short — a rule that returned 'partial' stays `classified`, and the stale-classification and act-window stand-downs both wrote status='no_action' without ever reading `order.placedQty`, so "sell 100% of 1000" that placed 264 and then met a rebound was filed as if nothing was owed, with 736 shares exposed and no alert. Every terminal write now goes through ONE closer (closeRule): a rule that moved shares but did not complete its intent ends in the new terminal status `fired_short` (never `no_action`) with truncated=true, a machine-readable shortReason, the exposed-share sentence on the timeline and a WARN — at EVERY exit, including expiry, a vanished book and an engine refusal, not just the two the previous round handled. (b) the ambiguous-failure retry was side-blind and could double-fill: the engine DELETEs its status='submitting' reservation in its catch, so a retry under the same requestId genuinely re-submits, and Schwab ignores clientOrderId (2026-08-18 twin fills). The retry now settles with the venue's own order record first (settleAtVenue → deps.listOrders over ±TRADING_EARNINGS_RULE_VENUE_LOOKBACK_MIN, matched symbol/side/qty exactly as rebindOrder does): a found order is ADOPTED rather than re-placed, a positively-absent SELL retries, a BUY never re-places, and an unaskable venue stops the rule loudly. The attempt bound is per RULE (a successful tranche no longer resets it, which used to multiply the bound by the tranche count). Also: the once-only timeline note now scans the whole timeline, so an interleaved entry no longer lets a 5xx deferral note repeat.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fix round 3: (a) a protective sell larger than one guardrail-capped order is no longer silently truncated to whatever fits and then marked `fired` — the operator's INTENT is split from what one order may carry (intendedRuleQty vs guardrailCappedQty), a sell finishes in TRANCHES over following ticks under distinct requestIds (intent fixed at the first fire, so an unfilled tranche cannot become an oversell, bounded by TRADING_EARNINGS_RULE_MAX_TRANCHES), and a rule that still ends short records the shares left exposed on its timeline, in the order state and in the decision rationale; (b) an UNKNOWN place failure (a broker adapter's plain Error — the engine deletes its reservation on the way out, and Schwab has no client-order-id) is now caught at the site, counted and bounded by TRADING_EARNINGS_RULE_MAX_PLACE_ATTEMPTS instead of re-firing every tick to expiry; (c) a classification older than TRADING_EARNINGS_RULE_STALE_HOURS stands the rule down rather than trading a stale verdict — which also bounds the 5xx defer loop; (d) the document-read retry bound is the TRADING_EARNINGS_RULE_MAX_DOC_ATTEMPTS knob, and the remaining exported CRUD helpers carry full JSDoc.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fix round 2: (a) size against the marketable LIMIT the order will carry, not the last print — the engine re-checks notional at refPrice = limit_price, so a cap-bound buy sized off the print exceeded the ceiling at the limit and was refused 422 guardrail_blocked, terminally (self-inflicted); (b) a 5xx from placeDecisionOrder (broker_not_configured, settlement_unknown — both thrown before any venue submission, reservation released) now leaves the rule `classified` to retry under the same requestId instead of permanently disarming the protective miss→sell, and the minted decision is REUSED and repriced across retries so a deferral does not fan out ledger rows; (c) every catch logs the err, the live-gate wait is debug (it ran every full tick), the EDGAR user agent is read per call, and a rule armed after its window opened says so on its timeline.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-136 D5 kernel half: the FORCE-RLS `oshal_trading_event_rules` store (one active rule per book+symbol via a partial unique index), the EDGAR 8-K item-2.02 watcher (held names, in-window only, CIK from the fundamentals lookup), the accountable trading-analyst read (executeBotOrInline → chat_tasks, agent id derived from the ACTIVE bot registry, never a hand-typed second copy), and the mapped action through the one order path as an 'event-rule' decision. Guards the engine does not cross for this shape: TRADING_HALT (placeDecisionOrder never reads it) and the notional ceiling (guardrailViolation skips it when refPrice is 0 — a market order) — hence self-sizing plus a marketable LIMIT. Every external seam (positions, EDGAR JSON, document text, analyst, latest trade, place, calendar, CIK) is injectable so the real-DB spec drives every transition without a venue.
 *
 * @module trading-earnings-rules
 */

import * as crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { getActiveRegistry } from '@/app/extensions/swarm/swarm-bot-registry';
import { createWorldIntelligenceService } from '@/features/world-data';
import { getBrokerReader, liveTradingEnabled, type OrderResult, type Position, type TradingBook } from '@/features/trading';
import { loadBook } from './trading-books-store';
import { guardrails, TradingError, type Guardrails } from './trading-engine';
import { defaultDeps, type EventPlanDeps } from './trading-event-plans';
import { resolveUserLlmConnection } from './routes/free-tier-rotation';
import { executeBotOrInline } from './routes/inline-bot-execution';

const logger = createChildLogger({ module: 'trading-earnings-rules' });

/**
 * The sentence every surface, prompt and rationale repeats. oshal has no consensus-estimate feed, so
 * "beat" and "miss" here can only mean the company's own filed numbers against its own history and its
 * own prior guidance. Saying so is the honest posture, not a caveat.
 */
export const CLASSIFICATION_BASIS =
  "Beat/miss is judged against the company's OWN filed numbers — the prior-year period and its own prior guidance — not Street consensus.";
/** The decision author for a fired rule. NOT operator-authored: a view-only book refuses its buys. */
export const EARNINGS_RULE_AGENT_ID = 'event-rule';
/** @description The EDGAR contact string (EDGAR 403s a default agent). Env EDGAR_USER_AGENT; read per call so the box does not need a restart to change it. */
export function edgarUserAgent(): string { return process.env.EDGAR_USER_AGENT || 'oshal-trading/1.0 (maintainer@emeraldcoastsystemsgroup.com)'; }

/* ── knobs (config → env → default; every one forwarded in compose) ─────────── */
const envNum = (name: string, dflt: number, min = 0): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : dflt;
};
/** @description True when the earnings watcher may run at all. Env TRADING_EARNINGS_RULES (default false). Also needs the leg gate TRADING_EVENT_PLANS. */
export function earningsRulesEnabled(): boolean { return String(process.env.TRADING_EARNINGS_RULES ?? 'false').toLowerCase() === 'true'; }
/** @description Days BEFORE the expected print the watcher starts polling. Env TRADING_EARNINGS_RULE_WINDOW_BEFORE_DAYS (default 1). */
export function ruleWindowBeforeDays(): number { return envNum('TRADING_EARNINGS_RULE_WINDOW_BEFORE_DAYS', 1); }
/** @description Days AFTER the expected print the watcher keeps polling (calendars slip). Env TRADING_EARNINGS_RULE_WINDOW_AFTER_DAYS (default 3). */
export function ruleWindowAfterDays(): number { return envNum('TRADING_EARNINGS_RULE_WINDOW_AFTER_DAYS', 3); }
/** @description Minimum first-print move (percent) in the verdict's direction before the action fires; 0 disables the second gate. Env TRADING_EARNINGS_RULE_REACTION_PCT (default 0.5). */
export function ruleReactionPct(): number { return envNum('TRADING_EARNINGS_RULE_REACTION_PCT', 0.5); }
/** @description Minutes (from the first regular-session tick after classification) to wait for the reaction before giving up. Env TRADING_EARNINGS_RULE_ACT_WINDOW_MIN (default 90). */
export function ruleActWindowMinutes(): number { return envNum('TRADING_EARNINGS_RULE_ACT_WINDOW_MIN', 90, 1); }
/** @description Analyst calls allowed per leg tick — the busy-earnings-morning cost bound. Env TRADING_EARNINGS_RULE_MAX_LLM_PER_TICK (default 3). */
export function ruleMaxLlmPerTick(): number { return Math.floor(envNum('TRADING_EARNINGS_RULE_MAX_LLM_PER_TICK', 3, 1)); }
/** @description Characters of the primary document handed to the analyst. Env TRADING_EARNINGS_RULE_DOC_CHARS (default 60000). */
export function ruleDocChars(): number { return Math.floor(envNum('TRADING_EARNINGS_RULE_DOC_CHARS', 60_000, 1000)); }
/** @description Farthest a rule may be set to expire (days). Env TRADING_EARNINGS_RULE_MAX_DAYS (default 120). */
export function ruleMaxDays(): number { return envNum('TRADING_EARNINGS_RULE_MAX_DAYS', 120, 1); }
/** @description Marketable-limit slippage (percent past the last print) so the engine's notional check has a refPrice. Env TRADING_EARNINGS_RULE_SLIPPAGE_PCT (default 0.5). */
export function ruleSlippagePct(): number { return envNum('TRADING_EARNINGS_RULE_SLIPPAGE_PCT', 0.5); }
/** @description Orders one rule may place in total — a protective sell larger than the fleet guardrails allow in ONE order is sold in tranches, and this bounds them. Env TRADING_EARNINGS_RULE_MAX_TRANCHES (default 5). */
export function ruleMaxTranches(): number { return Math.floor(envNum('TRADING_EARNINGS_RULE_MAX_TRANCHES', 5, 1)); }
/** @description Attempts after an UNKNOWN place failure (the venue state is ambiguous) before the rule gives up loudly. Counted per RULE, never per tranche. Env TRADING_EARNINGS_RULE_MAX_PLACE_ATTEMPTS (default 3). */
export function ruleMaxPlaceAttempts(): number { return Math.floor(envNum('TRADING_EARNINGS_RULE_MAX_PLACE_ATTEMPTS', 3, 1)); }
/** @description Minutes either side of an ambiguous attempt searched in the venue's OWN order record before deciding whether anything landed (the engine's rebind window is the same 15). Env TRADING_EARNINGS_RULE_VENUE_LOOKBACK_MIN (default 15). */
export function ruleVenueLookbackMin(): number { return envNum('TRADING_EARNINGS_RULE_VENUE_LOOKBACK_MIN', 15, 1); }
/** @description How long a classification may sit unacted (a deferring order rail, a market that never confirms) before the rule stands down rather than trade a stale verdict. Env TRADING_EARNINGS_RULE_STALE_HOURS (default 24). */
export function ruleStaleHours(): number { return envNum('TRADING_EARNINGS_RULE_STALE_HOURS', 24, 1); }
/** @description Attempts to fetch the filing's primary document before the rule errors. Env TRADING_EARNINGS_RULE_MAX_DOC_ATTEMPTS (default 3). */
export function ruleMaxDocAttempts(): number { return Math.floor(envNum('TRADING_EARNINGS_RULE_MAX_DOC_ATTEMPTS', 3, 1)); }
/** The fleet panic button. placeDecisionOrder does NOT read it — this module must. */
function tradingHalted(): boolean { return String(process.env.TRADING_HALT ?? '').toLowerCase() === 'true'; }

/* ── types ─────────────────────────────────────────────────────────────────── */
/** What a rule does for one verdict. */
export type EventRuleAction = 'buy' | 'sell' | 'hold';
/** How the fired order is sized. */
export interface EventRuleSizing { mode: 'pct_of_position' | 'shares' | 'notional'; value: number }
/**
 * The rule's lifecycle. `fired` = the intent completed. `fired_short` = shares MOVED and the intent did
 * not complete — the honest terminal for a rule that sold part of a position and then stopped, and the
 * status an operator must read as "check the exposure this rule left behind". `no_action` may only ever
 * describe a rule that never moved a share.
 */
export type EventRuleStatus = 'armed' | 'detected' | 'classified' | 'fired' | 'fired_short' | 'no_action' | 'expired' | 'cancelled' | 'error';
/** Why a rule stopped short of its intent — machine-readable beside the timeline sentence. */
export type RuleShortReason = 'guardrail_cap' | 'tranche_bound' | 'stale_verdict' | 'reaction_faded' | 'no_longer_held' | 'expired' | 'book_missing' | 'engine_refused' | 'venue_ambiguous';
/** The 8-K the watcher locked on to. */
export interface RuleFiling { form: string; accession: string; acceptedAt: string; filedDate: string; items: string; url: string; docAttempts?: number }
/** The analyst's structured read of the company's own release. */
export interface RuleClassification {
  verdict: 'beat' | 'miss' | 'inline' | 'unclear';
  revenue: { current: string | null; priorYear: string | null; pct: string | null };
  eps: { current: string | null; priorYear: string | null };
  guidance: { prior: string | null; comparison: string | null };
  rationale: string;
}
/**
 * The order state of a firing rule. `targetQty` is the operator's INTENT, fixed at the first fire; the
 * fleet guardrails cap what one order may carry, so a protective sell bigger than that cap is placed in
 * TRANCHES over following ticks (`placedQty` is what has been sent, never more than the target — an
 * unfilled tranche therefore cannot become an oversell). `truncated` is true whenever the rule stopped
 * short of its intent, which is stated on the timeline and in the decision rationale as well, and
 * `shortReason` says WHY in one machine-readable token. `attempts` counts ambiguous place failures for
 * the whole RULE and is never reset by a successful tranche — resetting it multiplied its own bound.
 * A tranche marked `adopted` was not placed by this rule at all: it was found in the venue's own order
 * record after an ambiguous failure and taken over instead of being placed a second time.
 */
export interface RuleOrderState {
  targetQty: number; placedQty: number; truncated: boolean; shortReason?: RuleShortReason | null;
  attempts: number; deferrals: number; pendingDecisionId: string | null;
  tranches: Array<{ n: number; id: string; status: string; qty: number; limitPrice: number; at: string; adopted?: boolean }>;
  firedAt?: string;
}
/** One rule row as the routes/UI see it. */
export interface EventRuleRow {
  ruleId: string; userSub: string; bookId: string; bookRef: string; symbol: string; event: 'earnings';
  onBeat: EventRuleAction; onMiss: EventRuleAction; onInline: EventRuleAction; sizing: EventRuleSizing;
  expectedAt: string | null; expiresAt: string; status: EventRuleStatus; cik: string | null;
  filing: RuleFiling | null; classification: RuleClassification | null; reaction: Record<string, unknown> | null;
  decisionId: string | null; order: RuleOrderState | null;
  timeline: Array<{ at: string; event: string; detail?: string }>; createdAt: string; updatedAt: string;
}
/** The validated shape createEventRule stores. */
export interface NormalizedEventRule {
  symbol: string; onBeat: EventRuleAction; onMiss: EventRuleAction; onInline: EventRuleAction;
  sizing: EventRuleSizing; expectedAt: string | null; expiresAt: Date;
}

const ACTIVE: EventRuleStatus[] = ['armed', 'detected', 'classified'];
const TERMINAL: EventRuleStatus[] = ['fired', 'fired_short', 'no_action', 'expired', 'cancelled', 'error'];
const ACTIONS: EventRuleAction[] = ['buy', 'sell', 'hold'];
const round2 = (n: number): number => Math.round(n * 100) / 100;
const money = (n: number | null | undefined): string => n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

/* ── validation ────────────────────────────────────────────────────────────── */
function actionOf(raw: unknown, dflt: EventRuleAction): EventRuleAction {
  const v = String(raw ?? '').trim().toLowerCase() as EventRuleAction;
  return ACTIONS.includes(v) ? v : dflt;
}

/** Sizing per mode, with the sell-all / quarter-position defaults the surface offers. */
function sizingOf(raw: unknown, buysAnything: boolean): EventRuleSizing {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode = String(r.mode ?? '') as EventRuleSizing['mode'];
  const value = Number(r.value);
  if (!['pct_of_position', 'shares', 'notional'].includes(mode) || !Number.isFinite(value)) {
    return buysAnything ? { mode: 'pct_of_position', value: 25 } : { mode: 'pct_of_position', value: 100 };
  }
  if (mode === 'pct_of_position' && (value < 1 || value > 100)) throw new TradingError(400, 'sizing_invalid', 'A percent-of-position size must be between 1 and 100.');
  if (mode === 'shares' && (!Number.isInteger(value) || value < 1)) throw new TradingError(400, 'sizing_invalid', 'A share size must be a whole number of at least 1.');
  if (mode === 'notional' && value < 1) throw new TradingError(400, 'sizing_invalid', 'A dollar size must be at least $1.');
  return { mode, value };
}

/**
 * @description Validate + default one operator rule. Refuses a rule that could never act (all three
 * verdicts mapped to hold) and one whose expiry is in the past or beyond the horizon — an armed rule
 * that can never fire is a promise the surface would keep showing forever.
 * @param raw - The rule as posted by the route.
 * @param now - The clock (injected for specs).
 * @returns The normalized rule.
 */
export function normalizeEventRule(raw: unknown, now: Date = new Date()): NormalizedEventRule {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const symbol = String(r.symbol ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z.\-]{0,5}$/.test(symbol)) throw new TradingError(400, 'symbol_required', 'A rule needs a ticker symbol (e.g. "MSFT").');
  const onBeat = actionOf(r.onBeat, 'buy'), onMiss = actionOf(r.onMiss, 'sell'), onInline = actionOf(r.onInline, 'hold');
  if (onBeat === 'hold' && onMiss === 'hold' && onInline === 'hold') {
    throw new TradingError(400, 'rule_noop', 'This rule holds on every outcome — it would never do anything. Map at least one outcome to a buy or a sell.');
  }
  const sizing = sizingOf(r.sizing, [onBeat, onMiss, onInline].includes('buy'));
  const expiresAt = new Date(String(r.expiresAt ?? ''));
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) throw new TradingError(400, 'expiry_invalid', 'A rule needs an expiry in the future.');
  if (expiresAt.getTime() > now.getTime() + ruleMaxDays() * 86_400_000) throw new TradingError(400, 'expiry_invalid', `A rule may not run for more than ${ruleMaxDays()} days.`);
  const expectedRaw = String(r.expectedAt ?? '').trim();
  if (expectedRaw && !/^\d{4}-\d{2}-\d{2}$/.test(expectedRaw)) throw new TradingError(400, 'expected_invalid', 'The expected print date must be YYYY-MM-DD.');
  return { symbol, onBeat, onMiss, onInline, sizing, expectedAt: expectedRaw || null, expiresAt };
}

/* ── schema ────────────────────────────────────────────────────────────────── */
let schemaReady = false;
/**
 * @description Create the FORCE-RLS rule table (idempotent, memoised per process — the leg calls it
 * every full tick). The partial unique index is what makes "one active rule per book+symbol" a
 * database fact rather than a race-prone read-then-write in the route.
 * @param pool - DB pool.
 * @returns Resolves when the table, indexes and owner policy exist.
 */
export async function ensureEventRulesSchema(pool: AppContext['pool']): Promise<void> {
  if (schemaReady) return;
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading earnings rules',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_event_rules (
        rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL, book_id UUID NOT NULL, book_ref TEXT NOT NULL,
        symbol TEXT NOT NULL, event TEXT NOT NULL DEFAULT 'earnings',
        on_beat TEXT NOT NULL, on_miss TEXT NOT NULL, on_inline TEXT NOT NULL,
        sizing JSONB NOT NULL, expected_at DATE, expires_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'armed', cik TEXT,
        filing JSONB, classification JSONB, reaction JSONB, decision_id UUID, "order" JSONB,
        timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_event_rules_one_active ON oshal_trading_event_rules (user_sub, book_id, symbol, event)
         WHERE status IN ('armed','detected','classified')`,
      'CREATE INDEX IF NOT EXISTS idx_trd_event_rules_user_status ON oshal_trading_event_rules (user_sub, status)',
      ...buildOwnerRlsPolicyStatements('oshal_trading_event_rules', 'user_sub'),
    ],
    requirements: [{ table: 'oshal_trading_event_rules', columns: ['rule_id', 'user_sub', 'book_id', 'symbol', 'status', 'sizing', 'expires_at', 'timeline'] }],
  });
  schemaReady = true;
}

/** A pg DATE comes back as a local-midnight Date; format it back to the calendar day it names. */
function dateOnly(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rowToRule(r: Record<string, unknown>): EventRuleRow {
  const iso = (v: unknown) => v == null ? null : new Date(v as string).toISOString();
  return {
    ruleId: String(r.rule_id), userSub: String(r.user_sub), bookId: String(r.book_id), bookRef: String(r.book_ref),
    symbol: String(r.symbol), event: 'earnings',
    onBeat: r.on_beat as EventRuleAction, onMiss: r.on_miss as EventRuleAction, onInline: r.on_inline as EventRuleAction,
    sizing: r.sizing as EventRuleSizing, expectedAt: dateOnly(r.expected_at), expiresAt: iso(r.expires_at) as string,
    status: r.status as EventRuleStatus, cik: r.cik == null ? null : String(r.cik),
    filing: (r.filing as RuleFiling) ?? null, classification: (r.classification as RuleClassification) ?? null,
    reaction: (r.reaction as Record<string, unknown>) ?? null,
    decisionId: r.decision_id == null ? null : String(r.decision_id), order: (r.order as RuleOrderState) ?? null,
    timeline: (r.timeline as EventRuleRow['timeline']) ?? [], createdAt: iso(r.created_at) as string, updatedAt: iso(r.updated_at) as string,
  };
}

/* ── CRUD ──────────────────────────────────────────────────────────────────── */
/**
 * @description Arm one rule on ONE book. The partial unique index refuses a second active rule for
 * the same (book, symbol) — surfaced as 409 rule_exists rather than a raw constraint error.
 * @param pool - DB pool.
 * @param sub - Owner.
 * @param input - The book the rule trades and the normalized rule.
 * @param now - Clock (injected for specs).
 * @returns The armed rule.
 */
export async function createEventRule(pool: AppContext['pool'], sub: string, input: { book: TradingBook; rule: NormalizedEventRule }, now: Date = new Date()): Promise<EventRuleRow> {
  await ensureEventRulesSchema(pool);
  const r = input.rule;
  const detail = `${r.symbol} on ${input.book.ref}: beat → ${r.onBeat}, miss → ${r.onMiss}, inline → ${r.onInline} (${sizingWords(r.sizing)}); expires ${r.expiresAt.toISOString().slice(0, 10)}`;
  try {
    const out = await pool.query(
      `INSERT INTO oshal_trading_event_rules (user_sub, book_id, book_ref, symbol, on_beat, on_miss, on_inline, sizing, expected_at, expires_at, timeline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [sub, input.book.bookId, input.book.ref, r.symbol, r.onBeat, r.onMiss, r.onInline, JSON.stringify(r.sizing), r.expectedAt, r.expiresAt.toISOString(),
        JSON.stringify([{ at: now.toISOString(), event: 'armed', detail }])]);
    logger.info({ sub, ruleId: out.rows[0].rule_id, symbol: r.symbol, book: input.book.ref }, 'earnings rule armed');
    return rowToRule(out.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new TradingError(409, 'rule_exists', `There is already an active earnings rule for ${r.symbol} on ${input.book.ref}. Cancel it first.`);
    }
    logger.error({ err, sub, symbol: r.symbol }, 'earnings rule insert failed');
    throw err;
  }
}

/** Words for a sizing, used in the timeline and the rationale. */
function sizingWords(s: EventRuleSizing): string {
  if (s.mode === 'pct_of_position') return `${s.value}% of the position`;
  if (s.mode === 'shares') return `${s.value} shares`;
  return `${money(s.value)}`;
}

/**
 * @description The caller's rules, newest first; optionally one book and/or a status set.
 * @param pool - DB pool.
 * @param sub - Owner (the RLS scope).
 * @param opts - Optional book id and status filter.
 * @returns The matching rules.
 */
export async function listEventRules(pool: AppContext['pool'], sub: string, opts?: { bookId?: string; status?: EventRuleStatus[] }): Promise<EventRuleRow[]> {
  await ensureEventRulesSchema(pool);
  const where = ['user_sub = $1']; const args: unknown[] = [sub];
  if (opts?.bookId) { args.push(opts.bookId); where.push(`book_id = $${args.length}`); }
  if (opts?.status?.length) { args.push(opts.status); where.push(`status = ANY($${args.length}::text[])`); }
  const r = await pool.query(`SELECT * FROM oshal_trading_event_rules WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, args);
  return r.rows.map(rowToRule);
}

/**
 * @description One rule by id, owner-scoped (a malformed id reads as "not found", never as a query).
 * @param pool - DB pool.
 * @param sub - Owner.
 * @param ruleId - The rule id.
 * @returns The rule, or null.
 */
export async function getEventRule(pool: AppContext['pool'], sub: string, ruleId: string): Promise<EventRuleRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(String(ruleId))) return null;
  await ensureEventRulesSchema(pool);
  const r = await pool.query('SELECT * FROM oshal_trading_event_rules WHERE user_sub = $1 AND rule_id = $2', [sub, ruleId]);
  return r.rows[0] ? rowToRule(r.rows[0]) : null;
}

async function patchRule(pool: AppContext['pool'], sub: string, ruleId: string, fields: Record<string, unknown>, event: { event: string; detail?: string } | undefined, now: Date): Promise<EventRuleRow> {
  const keys = Object.keys(fields); const args: unknown[] = [sub, ruleId];
  const sets = keys.map((k) => { args.push(fields[k] !== null && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]); return `"${k}" = $${args.length}`; });
  if (event) { args.push(JSON.stringify([{ at: now.toISOString(), ...event }])); sets.push(`timeline = timeline || $${args.length}::jsonb`); }
  sets.push('updated_at = now()');
  const r = await pool.query(`UPDATE oshal_trading_event_rules SET ${sets.join(', ')} WHERE user_sub = $1 AND rule_id = $2 RETURNING *`, args);
  if (!r.rows[0]) throw new TradingError(404, 'rule_not_found', 'No such earnings rule on this account.');
  return rowToRule(r.rows[0]);
}

/**
 * Has this rule already said this once? The leg ticks every few minutes, so a steady-state note ("not
 * held", "the rail is down") must not be appended on every one. Checking only the LAST entry was not
 * enough: one interleaved note (a `halted` between two deferrals) made the next one repeat, which is
 * exactly the timeline noise these notes exist to avoid. The whole timeline is the right scope.
 */
const alreadyNoted = (rule: EventRuleRow, event: string): boolean => rule.timeline.some((t) => t.event === event);

/** Append a timeline note only when the rule has not already recorded one of this kind. */
async function noteOnce(pool: AppContext['pool'], sub: string, rule: EventRuleRow, event: string, detail: string, now: Date): Promise<void> {
  if (alreadyNoted(rule, event)) return;
  await patchRule(pool, sub, rule.ruleId, {}, { event, detail }, now);
}

/**
 * @description Disarm an active rule so it never fires. Terminal rules are already inert.
 * @param pool - DB pool.
 * @param sub - Owner.
 * @param ruleId - The rule id.
 * @param now - Clock (injected for specs).
 * @returns The cancelled rule.
 * @throws TradingError 404 when there is no such rule, 409 when it is already terminal.
 */
export async function cancelEventRule(pool: AppContext['pool'], sub: string, ruleId: string, now: Date = new Date()): Promise<EventRuleRow> {
  const cur = await getEventRule(pool, sub, ruleId);
  if (!cur) throw new TradingError(404, 'rule_not_found', 'No such earnings rule on this account.');
  if (!ACTIVE.includes(cur.status)) throw new TradingError(409, 'rule_not_active', `This rule is already ${cur.status}.`);
  logger.info({ sub, ruleId, symbol: cur.symbol }, 'earnings rule cancelled');
  return patchRule(pool, sub, ruleId, { status: 'cancelled' }, { event: 'cancelled', detail: 'disarmed by the operator' }, now);
}

/**
 * @description Delete a rule that is no longer active (an active one must be cancelled first, so a
 * running rule can never be removed out from under its own order).
 * @param pool - DB pool.
 * @param sub - Owner.
 * @param ruleId - The rule id.
 * @returns True when a row was deleted, false when there was nothing to delete.
 * @throws TradingError 409 when the rule is still active.
 */
export async function deleteEventRule(pool: AppContext['pool'], sub: string, ruleId: string): Promise<boolean> {
  const cur = await getEventRule(pool, sub, ruleId);
  if (!cur) return false;
  if (!TERMINAL.includes(cur.status)) throw new TradingError(409, 'rule_active', `This rule is ${cur.status} — cancel it first.`);
  const r = await pool.query('DELETE FROM oshal_trading_event_rules WHERE user_sub = $1 AND rule_id = $2', [sub, ruleId]);
  return (r.rowCount ?? 0) > 0;
}

/* ── pure helpers (no I/O — the spec drives these directly) ─────────────────── */
/** @description The EDGAR submissions feed for a zero-padded 10-digit CIK. */
export function edgarSubmissionsUrl(cik10: string): string { return `https://data.sec.gov/submissions/CIK${cik10}.json`; }
/** @description The archive URL of a filing's primary document. */
export function edgarDocumentUrl(cik10: string, accession: string, primaryDocument: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik10)}/${accession.replace(/-/g, '')}/${primaryDocument}`;
}

interface EdgarRecent {
  accessionNumber?: string[]; filingDate?: string[]; acceptanceDateTime?: string[];
  form?: string[]; items?: string[]; primaryDocument?: string[];
}

/**
 * @description The newest 8-K carrying item 2.02 ("Results of Operations and Financial Condition")
 * accepted after `sinceIso`, or null. Walks EDGAR's parallel `filings.recent` arrays; acceptance time
 * (not filing date) is what makes "new" meaningful for a release that lands at 16:05 ET.
 * @param submissions - The parsed submissions JSON (unknown — it is a network shape).
 * @param sinceIso - Only filings accepted strictly after this instant count.
 * @param cik10 - The zero-padded CIK, for the document URL.
 * @returns The filing, or null when nothing new carries item 2.02.
 */
export function findNewEarningsFiling(submissions: unknown, sinceIso: string, cik10: string): RuleFiling | null {
  const recent = ((submissions as { filings?: { recent?: EdgarRecent } })?.filings?.recent ?? {}) as EdgarRecent;
  const forms = recent.form ?? [];
  const since = Date.parse(sinceIso);
  const hits: RuleFiling[] = [];
  for (let i = 0; i < forms.length; i++) {
    if (!/^8-K(\/A)?$/.test(String(forms[i] ?? ''))) continue;
    const items = String(recent.items?.[i] ?? '');
    if (!items.split(/[,\s]+/).includes('2.02')) continue;
    const acceptedAt = String(recent.acceptanceDateTime?.[i] ?? recent.filingDate?.[i] ?? '');
    const accepted = Date.parse(acceptedAt);
    if (!Number.isFinite(accepted) || (Number.isFinite(since) && accepted <= since)) continue;
    const accession = String(recent.accessionNumber?.[i] ?? '');
    const primary = String(recent.primaryDocument?.[i] ?? '');
    if (!accession || !primary) continue;
    hits.push({ form: String(forms[i]), accession, acceptedAt: new Date(accepted).toISOString(), filedDate: String(recent.filingDate?.[i] ?? ''), items, url: edgarDocumentUrl(cik10, accession, primary) });
  }
  return hits.sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt))[0] ?? null;
}

/**
 * @description Whether the rule is inside its earnings window right now — the ONLY thing that lets it
 * spend an EDGAR read. Either the world calendar says the print is within the before-window, or the
 * operator's expected date brackets today.
 * @param rule - The rule (its expected date).
 * @param now - The clock.
 * @param calendarDays - Days to the calendar's next earnings event, or null when unknown.
 * @returns True when the watcher may poll.
 */
export function inEarningsWindow(rule: Pick<EventRuleRow, 'expectedAt'>, now: Date, calendarDays: number | null): boolean {
  if (calendarDays != null && calendarDays <= ruleWindowBeforeDays()) return true;
  if (!rule.expectedAt) return false;
  const expected = Date.parse(`${rule.expectedAt}T00:00:00Z`);
  if (!Number.isFinite(expected)) return false;
  const from = expected - ruleWindowBeforeDays() * 86_400_000;
  const to = expected + (ruleWindowAfterDays() + 1) * 86_400_000;
  return now.getTime() >= from && now.getTime() < to;
}

/**
 * @description Whether the first regular-session print agrees with the verdict by at least `pct`.
 * A beat must trade up, a miss must trade down; an inline read has no direction to disagree with.
 * `pct` 0 disables the gate (the classification alone fires).
 * @param verdict - The analyst's verdict.
 * @param refPrice - The price when the filing was detected.
 * @param printPrice - The first regular-session print after it.
 * @param pct - The minimum move, in percent.
 * @returns True when the market agrees enough to act.
 */
export function reactionPasses(verdict: string | undefined, refPrice: number, printPrice: number, pct: number): boolean {
  if (pct <= 0) return true;
  if (!(refPrice > 0) || !(printPrice > 0)) return false;
  const move = ((printPrice - refPrice) / refPrice) * 100;
  if (verdict === 'beat') return move >= pct;
  if (verdict === 'miss') return move <= -pct;
  return true;
}

/**
 * @description The operator's INTENDED quantity, before the fleet guardrails — what "sell 100% of the
 * position" actually means. Kept separate from {@link guardrailCappedQty} because the difference is the
 * whole point: a protective sell whose intent exceeds what one order may carry must be RECOGNISED as
 * truncated (recorded, and finished in tranches), never silently reduced to whatever fits.
 * @param sizing - The rule's sizing.
 * @param heldQty - Shares currently held on the book.
 * @param orderPrice - The price the order will carry (the marketable limit).
 * @param cap - A hard share ceiling (the held quantity for a sell), or null.
 * @returns Whole shares the operator asked for — 0 when the sizing yields nothing.
 */
export function intendedRuleQty(sizing: EventRuleSizing, heldQty: number, orderPrice: number, cap: number | null): number {
  if (!(orderPrice > 0)) return 0;
  let qty = sizing.mode === 'pct_of_position' ? Math.floor(heldQty * sizing.value / 100)
    : sizing.mode === 'shares' ? Math.floor(sizing.value)
      : Math.floor(sizing.value / orderPrice);
  if (cap != null) qty = Math.min(qty, Math.floor(cap));
  return qty > 0 ? qty : 0;
}

/**
 * @description Cap a quantity by the fleet guardrails at the price the order will carry. The notional
 * cap is enforced HERE and not only by the engine: `guardrailViolation` skips the notional test whenever
 * the reference price is 0, which is what a market order hands it.
 *
 * `orderPrice` MUST be the price the order will actually carry — the marketable limit, not the last
 * print. The engine re-checks the same ceiling at `refPrice = limit_price`, so capping a cap-bound buy
 * off the (lower) print mints qty × limit > maxNotionalUsd and the engine refuses it 422
 * guardrail_blocked. Capping at the limit makes both checks agree.
 * @param qty - The intended whole-share quantity.
 * @param orderPrice - The price the order will carry.
 * @param g - The active guardrails.
 * @returns Whole shares one order may carry — 0 when no legal order exists.
 */
export function guardrailCappedQty(qty: number, orderPrice: number, g: Guardrails): number {
  if (!(orderPrice > 0)) return 0;
  let out = Math.floor(qty);
  if (g.maxQty > 0) out = Math.min(out, Math.floor(g.maxQty));
  if (g.maxNotionalUsd > 0 && out * orderPrice > g.maxNotionalUsd) out = Math.floor(g.maxNotionalUsd / orderPrice);
  return out > 0 ? out : 0;
}

/**
 * @description Intent then guardrails — the size of ONE order, which is what the rule places per tick.
 * @param sizing - The rule's sizing.
 * @param heldQty - Shares currently held on the book.
 * @param orderPrice - The price the order will carry (the marketable limit).
 * @param g - The active guardrails.
 * @param cap - A hard share ceiling (the held quantity for a sell), or null.
 * @returns Whole shares to order — 0 when it cannot size a legal order.
 */
export function sizeRuleOrder(sizing: EventRuleSizing, heldQty: number, orderPrice: number, g: Guardrails, cap: number | null): number {
  return guardrailCappedQty(intendedRuleQty(sizing, heldQty, orderPrice, cap), orderPrice, g);
}

/**
 * @description The marketable limit price for a side — the last print pushed by the slippage knob
 * (TRADING_EARNINGS_RULE_SLIPPAGE_PCT), so the order is marketable AND carries a refPrice the engine's
 * own notional check can use.
 * @param side - buy or sell.
 * @param price - The last regular-session print.
 * @returns The limit price, to the cent.
 */
export function marketableLimit(side: 'buy' | 'sell', price: number): number {
  const slip = ruleSlippagePct() / 100;
  return round2(side === 'buy' ? price * (1 + slip) : price * (1 - slip));
}

/**
 * @description The analyst prompt: read THIS release, answer with one JSON object. The output contract
 * lives here (not in a persona) so the read is deterministic, and it states the comparison basis so the
 * model is never invited to reach for a consensus number it does not have.
 * @param symbol - The ticker.
 * @param filing - The detected 8-K.
 * @param docText - The primary document's text (already truncated).
 * @returns The prompt.
 */
export function buildEarningsPrompt(symbol: string, filing: RuleFiling, docText: string): string {
  return [
    `You are reading ${symbol}'s own earnings release — SEC form ${filing.form}, item 2.02, accepted ${filing.acceptedAt}.`,
    CLASSIFICATION_BASIS,
    'You have NO analyst-consensus data and must not invent or recall any. Judge the company against the prior-year period it reports and against any prior guidance the release itself references.',
    'Answer with ONE fenced ```json block and nothing else, in this exact shape:',
    '{"verdict":"beat|miss|inline|unclear","revenue":{"current":"","priorYear":"","pct":""},"eps":{"current":"","priorYear":""},"guidance":{"prior":"","comparison":""},"rationale":""}',
    'Use "unclear" whenever the document does not actually contain the numbers — an unread filing must never become a trade.',
    'FILING TEXT:', docText,
  ].join('\n');
}

const strOrNull = (v: unknown): string | null => { const s = String(v ?? '').trim(); return s ? s.slice(0, 120) : null; };

/**
 * @description Parse the analyst's reply. Anything unparseable becomes verdict 'unclear', which maps
 * to no action — a malformed reply must never be read as a trading instruction.
 * @param raw - The model's raw text.
 * @returns The structured classification.
 */
export function parseEarningsReply(raw: string): RuleClassification {
  const empty: RuleClassification = { verdict: 'unclear', revenue: { current: null, priorYear: null, pct: null }, eps: { current: null, priorYear: null }, guidance: { prior: null, comparison: null }, rationale: 'The analyst reply could not be read as a verdict.' };
  try {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : (raw.match(/\{[\s\S]*\}/)?.[0] ?? '');
    const o = JSON.parse(candidate.trim()) as Record<string, Record<string, unknown> | string>;
    const verdict = String(o.verdict ?? '').toLowerCase();
    const rev = (o.revenue ?? {}) as Record<string, unknown>, eps = (o.eps ?? {}) as Record<string, unknown>, gd = (o.guidance ?? {}) as Record<string, unknown>;
    return {
      verdict: ['beat', 'miss', 'inline'].includes(verdict) ? verdict as RuleClassification['verdict'] : 'unclear',
      revenue: { current: strOrNull(rev.current), priorYear: strOrNull(rev.priorYear), pct: strOrNull(rev.pct) },
      eps: { current: strOrNull(eps.current), priorYear: strOrNull(eps.priorYear) },
      guidance: { prior: strOrNull(gd.prior), comparison: strOrNull(gd.comparison) },
      rationale: String((o as Record<string, unknown>).rationale ?? '').trim().slice(0, 600) || empty.rationale,
    };
  } catch (err) {
    logger.error({ err }, 'earnings analyst reply unparseable — treating as unclear (no trade)');
    return empty;
  }
}

/**
 * @description The action a rule maps its verdict to. 'unclear' always holds — a filing the analyst
 * could not read into a verdict must never become a trade.
 * @param rule - The rule's three mappings and its classification.
 * @returns buy, sell or hold.
 */
export function mapVerdictAction(rule: Pick<EventRuleRow, 'onBeat' | 'onMiss' | 'onInline' | 'classification'>): EventRuleAction {
  const v = rule.classification?.verdict;
  if (v === 'beat') return rule.onBeat;
  if (v === 'miss') return rule.onMiss;
  if (v === 'inline') return rule.onInline;
  return 'hold';
}

/**
 * The rationale the journal shows: the verdict, the numbers read, the filing, the basis — and, when the
 * fleet guardrails do not let ONE order carry the whole intent, that fact in words. A protective sell
 * that is quietly cut to a fraction of the position is the failure this sentence exists to prevent.
 */
function ruleRationale(rule: EventRuleRow, side: 'buy' | 'sell', qty: number, price: number, limitPrice: number, intended: number): string {
  const c = rule.classification;
  const ref = Number((rule.reaction ?? {}).refPrice ?? 0);
  const movePct = ref > 0 ? (((price - ref) / ref) * 100).toFixed(2) : '—';
  const short = intended > qty
    ? ` GUARDRAIL-TRUNCATED: ${sizingWords(rule.sizing)} is ${intended} shares and the fleet guardrails (TRADING_MAX_NOTIONAL_USD / TRADING_MAX_QTY) allow ${qty} in one order — the remaining ${intended - qty} ${side === 'sell' ? 'are placed on the following ticks' : 'are not bought'}.`
    : '';
  return [
    `Earnings rule ${rule.symbol}: 8-K item 2.02 accepted ${rule.filing?.acceptedAt} (${rule.filing?.url}) — ${String(c?.verdict ?? 'unclear').toUpperCase()}.`,
    `Revenue ${c?.revenue.current ?? '—'} vs ${c?.revenue.priorYear ?? '—'} prior year (${c?.revenue.pct ?? '—'}); EPS ${c?.eps.current ?? '—'} vs ${c?.eps.priorYear ?? '—'}.`,
    `Versus its own prior guidance (${c?.guidance.prior ?? '—'}): ${c?.guidance.comparison ?? '—'}.`,
    `First regular-session print ${money(price)} vs ${money(ref)} at detection (${movePct}%).`,
    `${side.toUpperCase()} ${qty} ${rule.symbol} as a ${money(limitPrice)} marketable limit, day.${short} ${CLASSIFICATION_BASIS}`,
  ].join(' ');
}

/* ── deps (injectable for the real-DB spec) ─────────────────────────────────── */
/** Everything the tick touches outside the database — swapped for fakes in the spec. */
export interface EarningsRuleDeps extends Pick<EventPlanDeps, 'now' | 'session' | 'fetchText' | 'latestTrade' | 'place'> {
  positions: (book: TradingBook, sub: string) => Promise<Position[]>;
  /**
   * The venue's OWN order record for a time window — the only authority on what an ambiguous place
   * attempt actually did. Read-only (`getBrokerReader`, never the gated adapter): settling an unknown
   * must never be able to place, cancel or resize anything.
   */
  listOrders: (book: TradingBook, sub: string, fromIso: string, toIso: string) => Promise<OrderResult[]>;
  edgarJson: (url: string) => Promise<unknown>;
  calendarDaysToEarnings: (symbol: string) => Promise<number | null>;
  lookupCik: (symbol: string) => Promise<string | null>;
  analyst: (ctx: AppContext, sub: string, prompt: string) => Promise<string>;
}
const bindingOf = (b: TradingBook) => b.accountNumber ? { accountNumber: b.accountNumber, connectionKey: b.connectionKey } : undefined;
const botClient = new BotNodeClient(createRegistryEndpointResolver());

/**
 * @description The trading-analyst's agent id, DERIVED from the active bot registry rather than
 * hand-typed a third time (CLAUDE.md: the UUID must match across compose, registry, Redis, Postgres —
 * so it gets read from the registry, which cannot drift from itself).
 * @returns The agent id.
 */
export function tradingAnalystAgentId(): string {
  const id = getActiveRegistry().find((b) => b.name === 'trading-analyst')?.agentId;
  if (!id) throw new TradingError(503, 'analyst_unavailable', 'The trading-analyst bot is not in the active registry — the earnings read has no accountable identity.');
  return id;
}

async function defaultAnalyst(ctx: AppContext, sub: string, prompt: string): Promise<string> {
  const agentId = tradingAnalystAgentId();
  const byoLlmConnection = await resolveUserLlmConnection(ctx.pool, sub);
  const result = await executeBotOrInline(ctx, botClient, agentId, {
    text: prompt, taskId: `trading-earnings-${sub}`, workspaceFolderId: `trading-${sub}`,
    agentId, agenticMode: true, direct: true, userSub: sub, byoLlmConnection,
  });
  return String(result.response || '').trim();
}

async function defaultEdgarJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { 'User-Agent': edgarUserAgent(), Accept: 'application/json' } });
  if (!r.ok) throw new Error(`EDGAR submissions ${r.status}`);
  return r.json();
}

async function defaultCalendarDays(symbol: string): Promise<number | null> {
  try {
    const svc = createWorldIntelligenceService();
    if (!svc) return null;
    // market-events writes lowercase entity ids (`world:ticker:aapl`) — query the same case or never hit.
    const evs = await svc.upcomingEvents(Math.ceil(ruleWindowBeforeDays()) + 1, `world:ticker:${symbol.toLowerCase()}`);
    const first = evs.find((e) => e.eventType === 'earnings');
    if (!first) return null;
    return Math.max(0, Math.ceil((Date.parse(first.scheduledAt) - Date.now()) / 86_400_000));
  } catch (err) {
    logger.error({ err, symbol }, 'earnings calendar read failed — the window falls back to the rule expected date');
    return null;
  }
}

/**
 * The CIK lookup lives in the trading feature (fundamentals.ts) and must be reached through the FSD
 * barrel. It is loaded dynamically so this module compiles and ships before the one-line barrel export
 * is applied; until it is, a rule records `cik_unknown` on its timeline rather than silently doing
 * nothing invisible. The line to add is named in the log message.
 */
async function defaultLookupCik(symbol: string): Promise<string | null> {
  const barrel = await import('@/features/trading/index.js') as { lookupCik?: (s: string) => Promise<string | null> };
  if (typeof barrel.lookupCik !== 'function') {
    logger.error({ symbol }, "the @/features/trading barrel does not export lookupCik — add `export { fundamentalsSummary, lookupCik } from './services/fundamentals';` to src/features/trading/index.ts; earnings rules cannot resolve a CIK until then");
    return null;
  }
  return barrel.lookupCik(symbol);
}

/** @description The production deps: real clock, venue session, broker reader, EDGAR, world calendar, analyst, engine order path. */
export function defaultEarningsDeps(): EarningsRuleDeps {
  const base = defaultDeps();
  return {
    now: base.now, session: base.session, fetchText: base.fetchText, latestTrade: base.latestTrade, place: base.place,
    positions: (book, sub) => getBrokerReader(book.kind, sub, bindingOf(book)).getPositions(),
    listOrders: (book, sub, from, to) => getBrokerReader(book.kind, sub, bindingOf(book)).listOrders(from, to),
    edgarJson: defaultEdgarJson,
    calendarDaysToEarnings: defaultCalendarDays,
    lookupCik: defaultLookupCik,
    analyst: defaultAnalyst,
  };
}

/* ── the state machine ─────────────────────────────────────────────────────── */
/**
 * @description Run one tick over every active rule of one user. Each rule advances at most one step
 * per tick and every step lands on its timeline. Never throws for one rule's sake. Returns immediately
 * when TRADING_EARNINGS_RULES is off — no reads, no EDGAR, no model call.
 * @param ctx - App context (pool).
 * @param sub - The owner.
 * @param deps - Venue/EDGAR/analyst/clock deps (production by default; the spec injects fakes).
 * @returns How many active rules were seen and which transitioned.
 */
export async function tickEarningsRules(ctx: AppContext, sub: string, deps: EarningsRuleDeps = defaultEarningsDeps()): Promise<{ processed: number; transitions: string[] }> {
  if (!earningsRulesEnabled()) return { processed: 0, transitions: [] };
  await ensureEventRulesSchema(ctx.pool);
  const r = await ctx.pool.query('SELECT * FROM oshal_trading_event_rules WHERE user_sub = $1 AND status = ANY($2::text[]) ORDER BY created_at', [sub, ACTIVE]);
  const now = deps.now();
  const budget = { llm: ruleMaxLlmPerTick() };
  const transitions: string[] = [];
  for (const row of r.rows) {
    const rule = rowToRule(row);
    try {
      const next = await advanceRule(ctx, sub, rule, deps, budget, now);
      if (next) transitions.push(`${rule.ruleId}:${next}`);
    } catch (err) {
      logger.error({ err, ruleId: rule.ruleId, status: rule.status }, 'earnings rule tick failed');
      await patchRule(ctx.pool, sub, rule.ruleId, {}, { event: 'tick_error', detail: (err as Error).message.slice(0, 300) }, now)
        .catch((noteErr) => logger.error({ err: noteErr, ruleId: rule.ruleId }, 'earnings rule tick error could not be written to the timeline'));
    }
  }
  return { processed: r.rows.length, transitions };
}

/**
 * THE ONE TERMINAL WRITER. Every path that ends a rule goes through here, because the property that
 * matters is not true of any single path — it is true only if it is true of ALL of them: a rule that
 * has already MOVED SHARES may never be filed as though nothing happened.
 *
 * So: when `placedQty > 0` and the intent did not complete, the requested stand-down status
 * (`no_action`, `expired`, `fired`) is REWRITTEN to `fired_short`, `truncated` is set with the
 * machine-readable `shortReason`, the timeline sentence gains the shares left exposed and what to do
 * about them, and it logs WARN. An `error` close keeps `error` — that is louder still — but records the
 * same exposure. A rule that never placed anything keeps exactly the status and words it asked for.
 */
async function closeRule(
  ctx: AppContext, sub: string, rule: EventRuleRow, order: RuleOrderState,
  o: { status: EventRuleStatus; event: string; detail: string; shortReason: RuleShortReason }, now: Date,
): Promise<string> {
  if (order.placedQty <= 0) {
    // The order state still has to land even when nothing was placed — it carries the ambiguous-attempt
    // count, and dropping it on the terminal write is how a bound silently loses its last increment.
    // A rule that never had one and accumulated nothing keeps a null `order` rather than gaining noise.
    const carries = rule.order != null || order.attempts > 0 || order.deferrals > 0 || order.targetQty > 0 || order.tranches.length > 0;
    await patchRule(ctx.pool, sub, rule.ruleId, carries ? { status: o.status, order } : { status: o.status }, { event: o.event, detail: o.detail }, now);
    return o.status;
  }
  const exposed = Math.max(0, order.targetQty - order.placedQty);
  const short = exposed > 0;
  const status: EventRuleStatus = o.status === 'error' ? 'error' : (short ? 'fired_short' : 'fired');
  const placed = `${order.placedQty} of ${order.targetQty} ${rule.symbol} placed across ${order.tranches.length} order(s)`;
  const tail = short
    ? ` — TRUNCATED: ${exposed} shares were NOT ${mapVerdictAction(rule) === 'buy' ? 'bought' : 'sold and remain exposed'}; finish by hand or re-arm.`
    : '';
  await patchRule(ctx.pool, sub, rule.ruleId,
    { status, order: { ...order, truncated: short, shortReason: short ? o.shortReason : null, firedAt: order.firedAt ?? now.toISOString() } },
    { event: status === 'error' ? 'error' : (short ? 'fired_short' : 'fired'), detail: `${placed} — ${o.detail}${tail}` }, now);
  if (short) logger.warn({ sub, ruleId: rule.ruleId, symbol: rule.symbol, placed: order.placedQty, target: order.targetQty, exposed, reason: o.shortReason, status }, 'earnings rule ended SHORT of its intent — shares were moved and the intent did not complete');
  return status;
}

/** Expiry is checked FIRST: an expired rule never polls EDGAR, never reads a model, never places. */
async function advanceRule(ctx: AppContext, sub: string, rule: EventRuleRow, deps: EarningsRuleDeps, budget: { llm: number }, now: Date): Promise<string | null> {
  if (Date.parse(rule.expiresAt) <= now.getTime()) {
    return closeRule(ctx, sub, rule, ruleOrderState(rule), { status: 'expired', event: 'expired', detail: `the rule reached its expiry while ${rule.status}`, shortReason: 'expired' }, now);
  }
  const book = await loadBook(ctx.pool, sub, rule.bookId);
  if (!book) {
    return closeRule(ctx, sub, rule, ruleOrderState(rule), { status: 'error', event: 'error', detail: 'account/book no longer exists', shortReason: 'book_missing' }, now);
  }
  // Debug, not warn: this is the STEADY state of every live-book rule while TRADING_LIVE_ENABLED is
  // off, and it would otherwise log once per rule per full tick forever.
  if (book.kind === 'live' && !liveTradingEnabled()) { logger.debug({ ruleId: rule.ruleId }, 'live trading disabled — earnings rule waits'); return null; }
  if (rule.status === 'armed') return stepArmed(ctx, sub, rule, book, deps, now);
  if (rule.status === 'detected') return stepDetected(ctx, sub, rule, deps, budget, now);
  if (rule.status === 'classified') return stepClassified(ctx, sub, rule, book, deps, now);
  return null;
}

/** armed → detected: held name, in window, one submissions read, newest unseen 8-K item 2.02. */
async function stepArmed(ctx: AppContext, sub: string, rule: EventRuleRow, book: TradingBook, deps: EarningsRuleDeps, now: Date): Promise<string | null> {
  const held = (await deps.positions(book, sub)).find((p) => p.symbol.toUpperCase() === rule.symbol && p.qty > 0);
  if (!held) { await noteOnce(ctx.pool, sub, rule, 'not_held', `${rule.symbol} is not held on ${rule.bookRef} — the rule waits`, now); return null; }
  let cik = rule.cik;
  if (!cik) {
    cik = await deps.lookupCik(rule.symbol);
    if (!cik) { await noteOnce(ctx.pool, sub, rule, 'cik_unknown', `no SEC registrant found for ${rule.symbol} — the watcher cannot poll`, now); return null; }
    await patchRule(ctx.pool, sub, rule.ruleId, { cik }, undefined, now);
  }
  if (!inEarningsWindow(rule, now, await deps.calendarDaysToEarnings(rule.symbol))) return null;
  const since = watchSince(rule);
  const filing = findNewEarningsFiling(await deps.edgarJson(edgarSubmissionsUrl(cik)), since, cik);
  if (!filing) {
    // A rule armed INSIDE its window only counts filings accepted after it was armed — arming the
    // morning after a release must not act on yesterday's news. Say so once, so an operator watching a
    // rule sit `armed` through its print date can see the reason instead of guessing.
    if (Date.parse(rule.createdAt) > Date.parse(since) - 1000) {
      await noteOnce(ctx.pool, sub, rule, 'watching', `watching ${rule.symbol} for an 8-K item 2.02 accepted after ${since} (the moment this rule was armed) — an earlier release does not count`, now);
    }
    return null;
  }
  const refPrice = held.currentPrice ?? (held.qty > 0 ? held.marketValue / held.qty : 0);
  await patchRule(ctx.pool, sub, rule.ruleId, { status: 'detected', filing, reaction: { refPrice, detectedAt: now.toISOString() } },
    { event: 'filing_detected', detail: `${filing.form} item 2.02 accepted ${filing.acceptedAt} — ${filing.url}` }, now);
  logger.info({ sub, ruleId: rule.ruleId, symbol: rule.symbol, url: filing.url }, 'earnings filing detected');
  return 'detected';
}

/** Only filings accepted after the rule was armed (or after the window opened) count as "this print". */
function watchSince(rule: EventRuleRow): string {
  const created = Date.parse(rule.createdAt);
  const windowOpen = rule.expectedAt ? Date.parse(`${rule.expectedAt}T00:00:00Z`) - ruleWindowBeforeDays() * 86_400_000 : NaN;
  const since = Number.isFinite(windowOpen) ? Math.max(created, windowOpen) : created;
  return new Date(since).toISOString();
}

/** detected → classified: the primary document, read once by the accountable analyst. */
async function stepDetected(ctx: AppContext, sub: string, rule: EventRuleRow, deps: EarningsRuleDeps, budget: { llm: number }, now: Date): Promise<string | null> {
  if (budget.llm <= 0) return null;
  const filing = rule.filing as RuleFiling;
  const text = await deps.fetchText(filing.url);
  if (!text) {
    const docAttempts = Number(filing.docAttempts ?? 0) + 1;
    if (docAttempts >= ruleMaxDocAttempts()) {   // env TRADING_EARNINGS_RULE_MAX_DOC_ATTEMPTS
      await patchRule(ctx.pool, sub, rule.ruleId, { status: 'error', filing: { ...filing, docAttempts } }, { event: 'error', detail: `the filing document could not be read after ${docAttempts} attempts — ${filing.url}` }, now);
      return 'error';
    }
    await patchRule(ctx.pool, sub, rule.ruleId, { filing: { ...filing, docAttempts } }, { event: 'document_unavailable', detail: `attempt ${docAttempts} — retrying on the next tick` }, now);
    return null;
  }
  budget.llm -= 1;
  const classification = parseEarningsReply(await deps.analyst(ctx, sub, buildEarningsPrompt(rule.symbol, filing, text.slice(0, ruleDocChars()))));
  await patchRule(ctx.pool, sub, rule.ruleId, { status: 'classified', classification, reaction: { ...(rule.reaction ?? {}), classifiedAt: now.toISOString() } },
    { event: 'classified', detail: `${classification.verdict.toUpperCase()} — ${CLASSIFICATION_BASIS}` }, now);
  return 'classified';
}

/** classified → fired | partial | no_action: the mapped action, gated by the first regular-session print. */
async function stepClassified(ctx: AppContext, sub: string, rule: EventRuleRow, book: TradingBook, deps: EarningsRuleDeps, now: Date): Promise<string | null> {
  const action = mapVerdictAction(rule);
  if (action === 'hold') {
    const why = rule.classification?.verdict === 'unclear' ? 'the filing could not be read into a verdict — no trade' : `verdict ${rule.classification?.verdict} maps to hold`;
    return closeRule(ctx, sub, rule, ruleOrderState(rule), { status: 'no_action', event: 'no_action', detail: why, shortReason: 'stale_verdict' }, now);
  }
  const stale = await staleClassification(ctx, sub, rule, now);
  if (stale) return stale;
  if ((await deps.session()) !== 'regular') return null;
  const t = await deps.latestTrade(book, sub, rule.symbol);
  if (!t) return null;
  const gate = await reactionGate(ctx, sub, rule, t.price, now);
  if (gate === 'no_action' || gate === 'fired_short') return gate;
  if (gate !== 'pass') return null;
  return fireRule(ctx, sub, rule, book, action, t.price, deps, now);
}

/**
 * A verdict has a shelf life. A rule that stayed `classified` because the order rail kept deferring, or
 * because the market never confirmed inside a session, must not wake up a day later and trade on a read
 * of yesterday's release — and this is also what bounds the 5xx retry loop, which would otherwise run to
 * the rule's expiry. Env TRADING_EARNINGS_RULE_STALE_HOURS (default 24).
 *
 * A TRANCHED sell also sits `classified` between tranches, so this stand-down can land on a rule that
 * has ALREADY SOLD part of the position. That is precisely why it closes through {@link closeRule}:
 * standing down is still right (a day-old verdict is not a reason to trade), but filing it as
 * `no_action` would have told the operator nothing was owed while the untranched remainder sat exposed.
 */
async function staleClassification(ctx: AppContext, sub: string, rule: EventRuleRow, now: Date): Promise<string | null> {
  const at = Date.parse(String((rule.reaction ?? {}).classifiedAt ?? rule.updatedAt));
  if (!Number.isFinite(at) || now.getTime() - at <= ruleStaleHours() * 3_600_000) return null;
  const hours = Math.round((now.getTime() - at) / 3_600_000);
  logger.warn({ sub, ruleId: rule.ruleId, hours }, 'earnings rule stood down on a stale classification');
  return closeRule(ctx, sub, rule, ruleOrderState(rule), {
    status: 'no_action', event: 'no_action', shortReason: 'stale_verdict',
    detail: `the ${rule.classification?.verdict} read is ${hours}h old and never became an order (the order rail deferred, or the market never confirmed) — the rule stood down rather than trade a stale verdict`,
  }, now);
}

/**
 * The second gate: the market has to agree with the read, inside the act window.
 *
 * Like the staleness stand-down, this one can fire on a rule that has ALREADY placed a tranche — the
 * print rebounds while the rest of a 1000-share exit is still queued — so its stand-down closes through
 * {@link closeRule}. The gate itself is unchanged (a market that no longer confirms the verdict is a
 * real reason not to keep selling); what changed is that stopping half-way now SAYS so.
 */
async function reactionGate(ctx: AppContext, sub: string, rule: EventRuleRow, price: number, now: Date): Promise<'pass' | 'wait' | 'no_action' | 'fired_short'> {
  const reaction = { ...(rule.reaction ?? {}) } as Record<string, unknown>;
  if (!reaction.actWindowStartedAt) {
    reaction.actWindowStartedAt = now.toISOString();
    rule.reaction = reaction;
    await patchRule(ctx.pool, sub, rule.ruleId, { reaction }, undefined, now);
  }
  if (reactionPasses(rule.classification?.verdict, Number(reaction.refPrice ?? 0), price, ruleReactionPct())) return 'pass';
  const elapsedMin = (now.getTime() - Date.parse(String(reaction.actWindowStartedAt))) / 60_000;
  if (elapsedMin >= ruleActWindowMinutes()) {
    return await closeRule(ctx, sub, rule, ruleOrderState(rule), {
      status: 'no_action', event: 'no_action', shortReason: 'reaction_faded',
      detail: `the first ${Math.round(elapsedMin)} regular-session minutes did not move ${rule.symbol} ${ruleReactionPct()}% in the ${rule.classification?.verdict} direction — the rule stood down`,
    }, now) as 'no_action' | 'fired_short';
  }
  await noteOnce(ctx.pool, sub, rule, 'reaction_disagrees', `${money(price)} does not confirm the ${rule.classification?.verdict} read yet — waiting up to ${ruleActWindowMinutes()} min`, now);
  return 'wait';
}

/** The rule's order state, defaulted for a rule that has not placed anything yet. */
function ruleOrderState(rule: EventRuleRow): RuleOrderState {
  const o = (rule.order ?? {}) as Partial<RuleOrderState>;
  return {
    targetQty: Number(o.targetQty ?? 0), placedQty: Number(o.placedQty ?? 0), truncated: Boolean(o.truncated),
    attempts: Number(o.attempts ?? 0), deferrals: Number(o.deferrals ?? 0), pendingDecisionId: o.pendingDecisionId ?? null,
    tranches: Array.isArray(o.tranches) ? o.tranches : [], firedAt: o.firedAt,
  };
}

/**
 * Place the mapped action through the ONE order path — with the two guards the engine will not apply.
 *
 * The intent (`targetQty`) is fixed at the FIRST fire and never re-derived, so a tranched sell cannot
 * re-size itself as the position shrinks, and a `shares`/`notional` sizing cannot repeat itself. What
 * ONE order may carry is `targetQty` minus what has already been sent, capped by the fleet guardrails.
 */
async function fireRule(ctx: AppContext, sub: string, rule: EventRuleRow, book: TradingBook, side: 'buy' | 'sell', price: number, deps: EarningsRuleDeps, now: Date): Promise<string | null> {
  if (tradingHalted()) { await noteOnce(ctx.pool, sub, rule, 'halted', 'TRADING_HALT is on — the rule holds its action until trading resumes', now); return null; }
  const heldQty = (await deps.positions(book, sub)).find((p) => p.symbol.toUpperCase() === rule.symbol && p.qty > 0)?.qty ?? 0;
  const order = ruleOrderState(rule);
  if (heldQty <= 0) {
    return closeRule(ctx, sub, rule, order, {
      status: 'no_action', event: 'no_action', shortReason: 'no_longer_held',
      detail: `${rule.symbol} is no longer held on ${rule.bookRef} (sold by the operator or the earnings blackout) — the rule does not open a fresh position`,
    }, now);
  }
  // Size at the LIMIT the order will carry, not the print: the engine re-checks the same notional
  // ceiling at refPrice = limit_price, and a cap-bound buy sized off the print is refused there.
  const limitPrice = marketableLimit(side, price);
  if (!order.targetQty) order.targetQty = intendedRuleQty(rule.sizing, heldQty, limitPrice, side === 'sell' ? heldQty : null);
  const remaining = Math.max(0, Math.min(order.targetQty - order.placedQty, side === 'sell' ? heldQty : order.targetQty));
  const qty = guardrailCappedQty(remaining, limitPrice, guardrails());
  if (qty < 1) {
    // Nothing left to place. A rule that already sent tranches ends through the closer (complete →
    // `fired`, short → `fired_short`); one that never placed anything cannot size a legal order at all,
    // which is an operator-visible configuration error.
    if (order.placedQty > 0) return closeRule(ctx, sub, rule, order, { status: 'fired', event: 'fired', detail: 'the guardrails size no further order', shortReason: 'guardrail_cap' }, now);
    await patchRule(ctx.pool, sub, rule.ruleId, { status: 'error' }, { event: 'error', detail: `${sizingWords(rule.sizing)} of ${heldQty} shares at a ${money(limitPrice)} limit sizes no legal order under the guardrails` }, now);
    return 'error';
  }
  return placeTranche(ctx, sub, rule, book, { side, qty, limitPrice, price, remaining, order }, deps, now);
}

/** One order of a (possibly tranched) action: mint-or-reprice the decision, place it, record what happened. */
async function placeTranche(ctx: AppContext, sub: string, rule: EventRuleRow, book: TradingBook, o: { side: 'buy' | 'sell'; qty: number; limitPrice: number; price: number; remaining: number; order: RuleOrderState }, deps: EarningsRuleDeps, now: Date): Promise<string | null> {
  const { order, side, qty, limitPrice } = o;
  const n = order.tranches.length + 1;
  // Tranche 1 keeps the rule's plain requestId; each further tranche is a DISTINCT order and needs a
  // distinct one, or the engine's reservation arbiter would no-op the rest of a protective sell.
  const requestId = n === 1 ? `erule-${rule.ruleId.slice(0, 8)}` : `erule-${rule.ruleId.slice(0, 8)}-${n}`;
  const why = ruleRationale(rule, side, qty, o.price, limitPrice, o.remaining);
  // Captured OUTSIDE the try: the failure path needs the id this attempt actually minted, and `rule` is
  // the row as it was read at the start of the tick — its decisionId is still null on a first fire.
  let decisionId: string | null = null;
  try {
    decisionId = await ensureRuleDecision(ctx.pool, sub, book, rule, order, { side, qty, limitPrice, why }, now);
    const res = await deps.place(ctx.pool, sub, book, decisionId, requestId);
    return recordPlacement(ctx, sub, rule, { order, side, qty, limitPrice, n, decisionId, orderId: String(res.id), status: String(res.status) }, now);
  } catch (err) {
    return placeRefusal(ctx, sub, rule, book, order, { side, qty, limitPrice, n, decisionId, err }, deps, now);
  }
}

/**
 * Book ONE order into the rule's state. Both ways an order can come to exist run through here — this
 * rule placed it, or the venue turned out to already hold it after an ambiguous submission and it was
 * ADOPTED — so an adopted order is counted exactly once and can never be placed a second time.
 * `attempts` is deliberately NOT reset: it bounds ambiguous failures for the whole RULE, and resetting
 * it on every successful tranche multiplied the bound by the number of tranches.
 */
async function recordPlacement(ctx: AppContext, sub: string, rule: EventRuleRow, o: { order: RuleOrderState; side: 'buy' | 'sell'; qty: number; limitPrice: number; n: number; decisionId: string | null; orderId: string; status: string; adopted?: boolean }, now: Date): Promise<string> {
  const { order, side, qty, limitPrice, n } = o;
  order.pendingDecisionId = null;                   // at the venue: the NEXT tranche mints its own decision
  order.placedQty += qty;
  order.deferrals = 0;
  order.tranches.push({ n, id: o.orderId, status: o.status, qty, limitPrice, at: now.toISOString(), ...(o.adopted ? { adopted: true } : {}) });
  logger.info({ sub, ruleId: rule.ruleId, orderId: o.orderId, side, qty, tranche: n, placed: order.placedQty, target: order.targetQty, adopted: Boolean(o.adopted) },
    o.adopted ? 'earnings rule ADOPTED the order the venue already held — not re-placed' : 'earnings rule order placed');
  const short = order.placedQty < order.targetQty;
  const detail = `${side.toUpperCase()} ${qty} ${rule.symbol} limit ${money(limitPrice)} day (${o.status})${o.adopted ? ' — ADOPTED from the venue order record after an ambiguous submission; nothing was re-placed' : ''}`;
  if (short && side === 'sell' && n < ruleMaxTranches()) {
    await patchRule(ctx.pool, sub, rule.ruleId, { ...(o.decisionId ? { decision_id: o.decisionId } : {}), order },
      { event: 'partial', detail: `${detail} — ${order.placedQty} of ${order.targetQty} placed; the guardrails cap one order, so the remaining ${order.targetQty - order.placedQty} follow on the next ticks` }, now);
    return 'partial';
  }
  return closeRule(ctx, sub, rule, order, {
    status: 'fired', event: 'fired', shortReason: side === 'sell' ? 'tranche_bound' : 'guardrail_cap',
    detail: `${detail}${short ? ' — TRADING_MAX_NOTIONAL_USD / TRADING_MAX_QTY cap one order and TRADING_EARNINGS_RULE_MAX_TRANCHES caps how many a rule may place; raise them or finish by hand' : ''}`,
  }, now);
}

/**
 * Three classes of failure, and they are NOT the same risk:
 *   • a 4xx TradingError is a decision about THIS order (book_disabled, guardrail_blocked,
 *     not_actionable, duplicate_submission) — terminal.
 *   • a 5xx TradingError is the rail being briefly unavailable: `broker_not_configured` (a Schwab
 *     token-refresh blip) and `settlement_unknown` are both raised BEFORE any venue submission and the
 *     engine releases its reservation on the way out, so nothing was placed and the next tick may retry
 *     under the same requestId. Terminal here would silently disarm the PROTECTIVE miss-to-sell half,
 *     and the kernel has no re-arm path. Bounded by the staleness stand-down, not by an attempt count.
 *   • anything ELSE (a broker adapter throwing a plain Error, a socket hangup) is AMBIGUOUS — not
 *     failed, UNKNOWN — and is handed to {@link ambiguousPlace}, which asks the venue rather than guesses.
 */
async function placeRefusal(ctx: AppContext, sub: string, rule: EventRuleRow, book: TradingBook, order: RuleOrderState, o: { side: 'buy' | 'sell'; qty: number; limitPrice: number; n: number; decisionId: string | null; err: unknown }, deps: EarningsRuleDeps, now: Date): Promise<string | null> {
  const te = o.err instanceof TradingError ? o.err : null;
  const msg = (o.err as Error)?.message?.slice(0, 200) ?? 'unknown error';
  if (te && te.httpStatus >= 500) {
    order.deferrals += 1;
    logger.error({ err: o.err, sub, ruleId: rule.ruleId, code: te.code, deferrals: order.deferrals }, 'earnings rule order deferred — the order rail is temporarily unavailable; retrying on the next tick');
    // Once per RULE, scanned over the whole timeline: checking only the last entry let one interleaved
    // note (a `halted`, a `partial`) re-open the floodgate this note exists to close.
    const note = alreadyNoted(rule, 'place_deferred') ? undefined : { event: 'place_deferred', detail: `${te.code}: ${msg} — nothing was submitted; the rule keeps its action and retries` };
    await patchRule(ctx.pool, sub, rule.ruleId, { order }, note, now);
    return null;
  }
  if (te) {
    logger.error({ err: o.err, sub, ruleId: rule.ruleId, code: te.code }, 'earnings rule refused by the engine — terminal');
    return closeRule(ctx, sub, rule, order, { status: 'error', event: 'error', detail: `${te.code}: ${msg}`, shortReason: 'engine_refused' }, now);
  }
  return ambiguousPlace(ctx, sub, rule, book, order, { ...o, msg }, deps, now);
}

/**
 * An AMBIGUOUS submission: the adapter threw something that is not an engine decision, so the venue may
 * or may not hold the order. The old behaviour — retry up to N times on either side — is a double-fill
 * path in this codebase, not a theoretical one: `placeDecisionOrder` DELETEs its `status='submitting'`
 * reservation in its catch, so the same requestId submits again for real, and Schwab ignores
 * clientOrderId (the 2026-08-18 twin fills). So: settle with the venue FIRST, then decide by side.
 *   • adopted   — the venue has it. Never re-placed.
 *   • sell      — only when the venue positively has nothing. A protective exit that stops half-done is
 *                 the harm this feature exists to prevent, and `remaining` is re-capped by the CURRENT
 *                 held quantity every tick, so a duplicate that filled cannot become a naked short.
 *   • buy       — never. A missed entry costs an opportunity; a duplicate buy costs capital nobody asked
 *                 for, this module does not repeat buys at all, and venue enumeration can lag a
 *                 just-entered order — the race has to resolve toward the cheaper mistake.
 *   • unaskable — never, either side. It stops loudly naming the ambiguity.
 */
async function ambiguousPlace(ctx: AppContext, sub: string, rule: EventRuleRow, book: TradingBook, order: RuleOrderState, o: { side: 'buy' | 'sell'; qty: number; limitPrice: number; n: number; decisionId: string | null; msg: string; err: unknown }, deps: EarningsRuleDeps, now: Date): Promise<string | null> {
  order.attempts += 1;                              // per RULE, never reset by a successful tranche
  const bound = ruleMaxPlaceAttempts();
  logger.error({ err: o.err, sub, ruleId: rule.ruleId, attempts: order.attempts, side: o.side, qty: o.qty }, 'earnings rule order failed with an unknown error — asking the venue what it actually did before deciding');
  const settled = await settleAtVenue(deps, book, sub, { symbol: rule.symbol, side: o.side, qty: o.qty, known: order.tranches.map((t) => t.id) }, now);
  if (settled.state === 'found') {
    logger.warn({ sub, ruleId: rule.ruleId, orderId: settled.order.id, status: settled.order.status }, 'the venue already holds the ambiguous order — adopting it rather than placing a second');
    return recordPlacement(ctx, sub, rule, { ...o, order, orderId: String(settled.order.id), status: String(settled.order.status), adopted: true }, now);
  }
  const evidence = settled.state === 'absent'
    ? `the venue's own order record shows no ${rule.symbol} ${o.side} x${o.qty} in the ${ruleVenueLookbackMin()}-minute window, so nothing landed`
    : settled.why;
  if (settled.state === 'absent' && o.side === 'sell' && order.attempts < bound) {
    await patchRule(ctx.pool, sub, rule.ruleId, { order },
      { event: 'place_failed', detail: `${o.msg} — attempt ${order.attempts} of ${bound}; ${evidence}, so the protective sell is retried on the next tick` }, now);
    return null;
  }
  const why = settled.state !== 'absent' ? `${evidence} — nothing is re-placed on an unknown`
    : o.side === 'buy' ? `${evidence}, but a rule never re-places a BUY: a duplicate entry costs real capital and venue records can lag a just-entered order`
      : `${evidence}, and the per-rule attempt bound (${bound}) is spent`;
  return closeRule(ctx, sub, rule, order, { status: 'error', event: 'error', shortReason: 'venue_ambiguous', detail: `${o.msg} — attempt ${order.attempts} of ${bound}; ${why}. CHECK THE ACCOUNT before re-arming` }, now);
}

/** What the venue's own record says about an ambiguous submission. */
type VenueSettlement = { state: 'found'; order: OrderResult } | { state: 'absent' } | { state: 'unknown'; why: string };

/**
 * Ask the venue what it actually did — the same authority and the same predicate the engine's
 * `rebindOrder` uses (enumerate the window, match symbol/side/qty, and refuse to guess when the count
 * is not exactly one). Orders this rule already knows about are excluded first: a tranched sell places
 * identically-sized orders, so its OWN earlier tranche would otherwise read as a mystery duplicate and
 * strand the exit. An order the venue already terminated with zero fills did not land, so it does not
 * count as one. Read-only throughout — settling an unknown must never place, cancel or resize anything.
 */
async function settleAtVenue(deps: EarningsRuleDeps, book: TradingBook, sub: string, o: { symbol: string; side: 'buy' | 'sell'; qty: number; known: string[] }, now: Date): Promise<VenueSettlement> {
  const w = ruleVenueLookbackMin() * 60_000;
  const dead = ['rejected', 'canceled', 'cancelled', 'expired'];
  try {
    const seen = await deps.listOrders(book, sub, new Date(now.getTime() - w).toISOString(), new Date(now.getTime() + w).toISOString());
    const hits = seen.filter((x) => x.id && !o.known.includes(String(x.id))
      && String(x.symbol ?? '').toUpperCase() === o.symbol && x.side === o.side && Math.abs(Number(x.qty) - o.qty) < 1e-6
      && !(dead.includes(String(x.status)) && Number(x.filledQty || 0) === 0));
    if (hits.length === 1) return { state: 'found', order: hits[0] };
    if (hits.length === 0) return { state: 'absent' };
    return { state: 'unknown', why: `the venue's order record holds ${hits.length} live ${o.symbol} ${o.side} x${o.qty} orders in the ${ruleVenueLookbackMin()}-minute window — refusing to guess which one this rule sent` };
  } catch (err) {
    logger.error({ err, sub, ruleId: book.ref, symbol: o.symbol }, 'the venue order record could not be read — an ambiguous submission cannot be settled');
    return { state: 'unknown', why: `the venue's order record could not be read (${(err as Error)?.message?.slice(0, 120) ?? 'unknown error'}), so what happened to this submission is unknown` };
  }
}

/**
 * Mint the tranche's decision ONCE and reprice it on a retry. A deferred attempt has already written a
 * signal + decision pair; minting a fresh one every five minutes for the length of an outage would fan
 * the journal out with proposals that never became orders. The pending id is stored on the rule as soon
 * as it exists (so a crash between mint and place cannot orphan one either), and cleared the moment the
 * order reaches the venue — the next tranche is a different order and mints its own.
 */
async function ensureRuleDecision(pool: AppContext['pool'], sub: string, book: TradingBook, rule: EventRuleRow, order: RuleOrderState, o: { side: 'buy' | 'sell'; qty: number; limitPrice: number; why: string }, now: Date): Promise<string> {
  if (order.pendingDecisionId) {
    await pool.query(
      `UPDATE oshal_trading_decisions SET action=$3, side=$3, qty=$4, limit_price=$5, rationale=$6, guardrails=$7
         WHERE decision_id=$1 AND user_sub=$2`,
      [order.pendingDecisionId, sub, o.side, o.qty, o.limitPrice, o.why, JSON.stringify(guardrails())]);
    return order.pendingDecisionId;
  }
  const decisionId = await mintRuleDecision(pool, sub, book, rule, o);
  order.pendingDecisionId = decisionId;
  await patchRule(pool, sub, rule.ruleId, { decision_id: decisionId, order }, undefined, now);
  return decisionId;
}

/** Mint the 'event-rule' signal + decision the engine executes (book_id explicit on both). */
async function mintRuleDecision(pool: AppContext['pool'], sub: string, book: TradingBook, rule: EventRuleRow, o: { side: 'buy' | 'sell'; qty: number; limitPrice: number; why: string }): Promise<string> {
  const hash = crypto.createHash('sha256').update(JSON.stringify({ source: EARNINGS_RULE_AGENT_ID, ruleId: rule.ruleId, ...o, at: Date.now() })).digest('hex');
  const sig = (await pool.query(
    `INSERT INTO oshal_trading_signals (user_sub, mode, book_id, source, title, body, url, symbols, indicators, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING signal_id`,
    [sub, book.kind, book.bookId, EARNINGS_RULE_AGENT_ID, `Earnings rule: ${rule.symbol}`, o.why, rule.filing?.url ?? null, [rule.symbol],
      JSON.stringify({ ruleId: rule.ruleId, filing: rule.filing, classification: rule.classification, basis: CLASSIFICATION_BASIS }), hash])).rows[0];
  const row = (await pool.query(
    `INSERT INTO oshal_trading_decisions (user_sub, mode, book_id, signal_ids, agent_id, action, symbol, side, qty, order_type, limit_price, time_in_force, confidence, rationale, indicators, guardrails)
       VALUES ($1,$2,$3,$4::uuid[],$5,$6,$7,$6,$8,'limit',$9,'day',1,$10,$11,$12) RETURNING decision_id`,
    [sub, book.kind, book.bookId, [sig.signal_id], EARNINGS_RULE_AGENT_ID, o.side, rule.symbol, o.qty, o.limitPrice, o.why,
      JSON.stringify({ ruleId: rule.ruleId, verdict: rule.classification?.verdict ?? null }), JSON.stringify(guardrails())])).rows[0];
  return String(row.decision_id);
}
