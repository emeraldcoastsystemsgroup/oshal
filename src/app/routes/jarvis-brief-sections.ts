/**
 * Jarvis morning brief — SECTION COMPOSITION (pure orchestration over injected readers).
 *
 * The brief is a cross-app daily digest the controller can assemble from data that
 * ALREADY EXISTS in the platform's stores — it never calls an LLM and never does heavy
 * fetches (ADR-036: reasoning lives on bots; this is cheap I/O over cached/owned state).
 * Every section sits behind an availability guard: a user without the data/connection
 * gets an honest `{section, skipped, reason}` instead of fabricated content, and one
 * section failing can never take down the others (per-section try/catch, ERROR-logged).
 *
 * Sections (v1):
 *   - trading : yesterday's recap from deck-data.json (the daily-recap pipeline's truth
 *               file). OPERATOR-SCOPED — this is the deployment owner's own account, so
 *               the guard fails closed on the OSHAL_OPERATOR_SUBS/EMAILS allowlist.
 *   - career  : new high-fit matches since the user's last career digest (reuses the
 *               career-digest query + its ai_scored_at cursor; read-only, cursor untouched).
 *   - world   : freshest archived headlines for the most-covered world subjects (only
 *               when world intelligence is enabled on this deployment).
 *   - comms   : unread Gmail counts via ONE labels/UNREAD metadata GET on the user's own
 *               connection, plus the cached AI digest's freshness (never its content —
 *               that stays encrypted in oshal_email_digests).
 *
 * All readers are injected (BriefDeps) so the composition is unit-testable without a DB,
 * Gmail, or the world store; defaultBriefDeps(ctx) wires the real ones.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial morning-brief composition: four guarded sections (trading recap from deck-data.json operator-gated fail-closed, career preview via findNewHits + the digest cursor read-only, world headlines via the memoized WorldIntelligenceService, Gmail unread via one labels/UNREAD GET), injectable BriefDeps for unit tests, per-section error isolation.
 *
 * @module jarvis-brief-sections
 */
import * as fs from 'fs';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';
import { isOperatorIdentity } from '@/shared/middleware/authz';
import { createWorldIntelligenceService } from '@/features/world-data';
import type { AppContext } from '@/app/composition/app-context';
// ADR-085 Wave 3: career-hunter ships as a store package — the brief resolves its
// hits API through the bridge (skip-if-absent) instead of deep-importing app modules.
import { briefFindCareerHits, briefHasCareerStore, type CareerBriefHit as DigestHit } from './career-brief-bridge';
import { getValidAccessToken } from './connectors-routes';

const logger = createChildLogger({ module: 'jarvis-brief-sections' });

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** A section the user lacks the data/connection for — honest skip, never fabricated content. */
export interface BriefSectionSkipped {
  section: string;
  title: string;
  skipped: true;
  reason: string;
}

/** A populated section: a one-line human summary plus the structured facts behind it. */
export interface BriefSectionData {
  section: string;
  title: string;
  skipped: false;
  summary: string;
  data: Record<string, unknown>;
}

/** One brief section — either populated or an explained skip. */
export type BriefSection = BriefSectionSkipped | BriefSectionData;

/** The composed brief: what /api/jarvis/brief returns and the morning delivery renders. */
export interface MorningBrief {
  generatedAt: string;
  userSub: string;
  sections: BriefSection[];
}

/** The slice of deck-data.json the trading section reads (the recap pipeline's truth file). */
export interface DeckData {
  date?: string;
  generatedAt?: string;
  mode?: string;
  results?: { pl?: number; pct?: number; equity?: number; fills?: number; positions?: number; leaders?: string };
  ytd?: { retPct?: number; retUsd?: number; last?: number };
}

/** One world headline surfaced in the brief. */
export interface WorldHeadline {
  entity: string;
  title: string;
  outlet: string;
  sentiment: number | null;
  pubDate: string | null;
}

/**
 * Injectable readers behind every section — the seam that makes composition unit-testable
 * (mock these) and keeps this module free of hard environmental coupling.
 */
export interface BriefDeps {
  /** Operator allowlist check (fail-closed: empty allowlist = nobody). Matches on sub OR email. */
  isOperator(userSub: string, email: string | null): boolean;
  /** The daily-recap truth file, or null when the pipeline hasn't produced one. */
  readDeckData(): DeckData | null;
  /** Whether this user has a career-hunter store at all. */
  hasCareerStore(userSub: string): boolean;
  /** The user's career-digest cursor (last_digest_at) — read-only, never advanced here. */
  readCareerCursor(userSub: string): Promise<string | null>;
  /** New high-fit matches since the cursor (the career-digest query, reused). */
  findCareerHits(userSub: string, sinceIso: string | null): DigestHit[];
  /** Fresh world headlines, or null when world intelligence is disabled on this deployment. */
  worldHeadlines(): Promise<WorldHeadline[] | null>;
  /** A valid Gmail access token for the user's OWN google connection, or null. */
  gmailToken(userSub: string): Promise<string | null>;
  /** Unread counters via one labels/UNREAD metadata GET, or null when the read fails. */
  gmailUnread(token: string): Promise<{ messagesUnread: number; threadsUnread: number } | null>;
  /** When the cached email AI digest was last refreshed (freshness only, never content). */
  emailDigestUpdatedAt(userSub: string): Promise<string | null>;
}

/** Resolved location of deck-data.json (env-overridable for containerized mounts). */
function deckDataPath(): string {
  return process.env.OSHAL_DECK_DATA_PATH
    || path.resolve(process.cwd(), 'packages', 'oshal-vids-operator', 'out', 'deck-data.json');
}

/** Read + parse deck-data.json off disk; null (logged at info — a normal state) when absent. */
function readDeckDataFromDisk(): DeckData | null {
  try {
    return JSON.parse(fs.readFileSync(deckDataPath(), 'utf8')) as DeckData;
  } catch (err) {
    logger.info({ err: (err as Error).message, path: deckDataPath() }, 'brief: deck-data.json unavailable');
    return null;
  }
}

/** Freshest archived headlines for the most-covered subjects; null = world layer disabled. */
async function readWorldHeadlines(): Promise<WorldHeadline[] | null> {
  const svc = createWorldIntelligenceService();
  if (!svc) return null;
  const entities = await svc.listEntities(3);
  const out: WorldHeadline[] = [];
  for (const e of entities) {
    const items = await svc.archivedItems(e.entity, 1, 2);
    for (const it of items) {
      out.push({ entity: it.entityLabel || e.label, title: it.title, outlet: it.outlet, sentiment: it.sentiment, pubDate: it.pubDate });
    }
  }
  return out;
}

/** One labels/UNREAD metadata GET on the user's own Gmail; null (logged) when it fails. */
async function readGmailUnread(token: string): Promise<{ messagesUnread: number; threadsUnread: number } | null> {
  const r = await fetch(`${GMAIL}/labels/UNREAD`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    logger.warn({ status: r.status }, 'brief: gmail labels/UNREAD read failed');
    return null;
  }
  const label = (await r.json()) as { messagesUnread?: number; threadsUnread?: number };
  return { messagesUnread: Number(label.messagesUnread) || 0, threadsUnread: Number(label.threadsUnread) || 0 };
}

/**
 * @description Build the REAL readers for one app context: deck-data.json off disk, the
 * career-digest cursor + hits query, the memoized world-intelligence service, and the
 * user's own Gmail connection via the token broker. Every reader degrades to null/empty
 * (logged) instead of throwing environment errors up into the composition.
 * @param ctx - App context (Postgres pool for cursor/connection reads).
 * @returns The production BriefDeps.
 */
export function defaultBriefDeps(ctx: AppContext): BriefDeps {
  return {
    isOperator: (userSub, email) => isOperatorIdentity(userSub, email),
    readDeckData: readDeckDataFromDisk,
    hasCareerStore: (userSub) => briefHasCareerStore(userSub),
    readCareerCursor: async (userSub) => {
      try {
        const r = await ctx.pool.query(
          'SELECT last_digest_at FROM career_digest_settings WHERE user_sub=$1', [userSub]);
        const at = r.rows[0]?.last_digest_at;
        return at ? new Date(at).toISOString() : null;
      } catch (err) {
        logger.error({ err, stack: (err as Error).stack, userSub }, 'brief: career cursor read failed — treating as first digest');
        return null;
      }
    },
    findCareerHits: (userSub, sinceIso) => briefFindCareerHits(userSub, sinceIso),
    worldHeadlines: readWorldHeadlines,
    gmailToken: (userSub) => getValidAccessToken(ctx.pool, userSub, 'google'),
    emailDigestUpdatedAt: async (userSub) => {
      try {
        const r = await ctx.pool.query('SELECT updated_at FROM oshal_email_digests WHERE user_sub=$1', [userSub]);
        const at = r.rows[0]?.updated_at;
        return at ? new Date(at).toISOString() : null;
      } catch (err) {
        // The table only exists once the email app has booted — a missing relation
        // (Postgres 42P01) is a normal pre-boot state, logged at debug. Any OTHER
        // error (pool exhaustion, connection drop) is a real fault and must not hide
        // behind the "no digest yet" degrade — surface it at ERROR with the stack.
        if ((err as { code?: string }).code === '42P01') {
          logger.debug({ userSub }, 'brief: oshal_email_digests not present yet — digest freshness omitted');
        } else {
          logger.error({ err, stack: (err as Error).stack, userSub }, 'brief: email digest freshness read failed');
        }
        return null;
      }
    },
    gmailUnread: readGmailUnread,
  };
}

/** Format a signed dollar amount for section summaries. */
function usd(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : '+'}$${abs}`;
}

/** Trading recap — operator-scoped (fail-closed) view over the recap pipeline's truth file. */
async function tradingSection(deps: BriefDeps, userSub: string, email: string | null): Promise<BriefSection> {
  const base = { section: 'trading', title: 'Trading recap' };
  if (!deps.isOperator(userSub, email)) {
    return { ...base, skipped: true, reason: 'Trading recap is scoped to the deployment operator (OSHAL_OPERATOR_SUBS/EMAILS allowlist; fail-closed).' };
  }
  const deck = deps.readDeckData();
  if (!deck || !deck.results) {
    return { ...base, skipped: true, reason: 'No recap available yet — the daily-recap pipeline has not produced deck-data.json.' };
  }
  const r = deck.results;
  const pl = Number(r.pl) || 0;
  const summary = `${deck.date || 'Last session'} (${deck.mode || 'paper'}): ${usd(pl)} (${r.pct ?? 0}%), `
    + `equity $${(Number(r.equity) || 0).toLocaleString('en-US')}, ${r.fills ?? 0} fills, ${r.positions ?? 0} open positions.`
    + (deck.ytd?.retPct != null ? ` Since inception: ${deck.ytd.retPct}% (${usd(Number(deck.ytd.retUsd) || 0)}).` : '');
  return {
    ...base, skipped: false, summary,
    data: {
      date: deck.date || null, mode: deck.mode || null, generatedAt: deck.generatedAt || null,
      pl, pct: r.pct ?? null, equity: r.equity ?? null, fills: r.fills ?? null,
      positions: r.positions ?? null, leaders: r.leaders || null,
      ytdPct: deck.ytd?.retPct ?? null, ytdUsd: deck.ytd?.retUsd ?? null,
    },
  };
}

/** Career preview — the digest query read-only (never advances the once/day cursor). */
async function careerSection(deps: BriefDeps, userSub: string): Promise<BriefSection> {
  const base = { section: 'career', title: 'Career digest' };
  if (!deps.hasCareerStore(userSub)) {
    return { ...base, skipped: true, reason: 'No career-hunter store for this user — connect the Career Hunter app to get match digests.' };
  }
  const since = await deps.readCareerCursor(userSub);
  const hits = deps.findCareerHits(userSub, since);
  const summary = hits.length
    ? `${hits.length} new high-fit match${hits.length === 1 ? '' : 'es'} since your last digest — top: ${hits.slice(0, 3).map((h) => `${h.fit}% ${h.title} @ ${h.company}`).join('; ')}.`
    : 'No new high-fit matches since your last digest.';
  return {
    ...base, skipped: false, summary,
    data: { newHits: hits.length, since, top: hits.slice(0, 3).map((h) => ({ title: h.title, company: h.company, fit: h.fit, url: h.url || null })) },
  };
}

/** World headlines — only when the world-intelligence layer is enabled on this deployment. */
async function worldSection(deps: BriefDeps): Promise<BriefSection> {
  const base = { section: 'world', title: 'World headlines' };
  const headlines = await deps.worldHeadlines();
  if (headlines === null) {
    return { ...base, skipped: true, reason: 'World intelligence is disabled on this deployment (ENABLE_WORLD_INTELLIGENCE / TSDB_URL / ARANGO_URL unset).' };
  }
  if (!headlines.length) {
    return { ...base, skipped: true, reason: 'World intelligence is enabled but no items have been archived in the last day.' };
  }
  const top = headlines.slice(0, 6);
  return {
    ...base, skipped: false,
    summary: `${top.length} fresh headline${top.length === 1 ? '' : 's'} across your most-covered subjects — ${top[0].entity}: “${top[0].title}”.`,
    data: { headlines: top },
  };
}

/** Comms — unread Gmail counters + digest-cache freshness. One metadata GET, no LLM. */
async function commsSection(deps: BriefDeps, userSub: string): Promise<BriefSection> {
  const base = { section: 'comms', title: 'Email' };
  const token = await deps.gmailToken(userSub);
  if (!token) {
    return { ...base, skipped: true, reason: 'No connected Google account — connect Gmail to get inbox counts in your brief.' };
  }
  const unread = await deps.gmailUnread(token);
  if (!unread) {
    return { ...base, skipped: true, reason: 'Gmail unread count unavailable (the metadata read failed — token may lack gmail scope).' };
  }
  const digestUpdatedAt = await deps.emailDigestUpdatedAt(userSub);
  return {
    ...base, skipped: false,
    summary: `${unread.messagesUnread} unread email${unread.messagesUnread === 1 ? '' : 's'} (${unread.threadsUnread} thread${unread.threadsUnread === 1 ? '' : 's'}).`
      + (digestUpdatedAt ? ` AI inbox digest last refreshed ${digestUpdatedAt.slice(0, 16).replace('T', ' ')} UTC.` : ''),
    data: { messagesUnread: unread.messagesUnread, threadsUnread: unread.threadsUnread, digestUpdatedAt },
  };
}

/**
 * @description Compose the full morning brief for one user: run every section builder,
 * isolating failures — a throwing section becomes an explained skip (ERROR-logged with
 * stack) and never poisons its siblings. Order is stable (trading, career, world, comms)
 * so renderers don't reshuffle day to day.
 * @param deps - Injected readers (defaultBriefDeps(ctx) in production; mocks in tests).
 * @param userSub - The authenticated caller the brief is scoped to.
 * @param email - The caller's email, for the operator allowlist (email-only-configured
 *   deployments match on OSHAL_OPERATOR_EMAILS); null when unknown (e.g. cron delivery,
 *   where the operator gate falls back to the sub allowlist).
 * @returns The composed brief with a generatedAt stamp.
 */
export async function composeMorningBrief(deps: BriefDeps, userSub: string, email: string | null = null): Promise<MorningBrief> {
  const builders: Array<[string, string, () => Promise<BriefSection>]> = [
    ['trading', 'Trading recap', () => tradingSection(deps, userSub, email)],
    ['career', 'Career digest', () => careerSection(deps, userSub)],
    ['world', 'World headlines', () => worldSection(deps)],
    ['comms', 'Email', () => commsSection(deps, userSub)],
  ];
  const sections: BriefSection[] = [];
  for (const [section, title, build] of builders) {
    try {
      sections.push(await build());
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, section, userSub }, 'brief: section failed — degrading to skip');
      sections.push({ section, title, skipped: true, reason: `Section unavailable (${(err as Error).message || 'internal error'}).` });
    }
  }
  return { generatedAt: new Date().toISOString(), userSub, sections };
}
